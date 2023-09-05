/* eslint-disable no-case-declarations */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda'

import { DocumentClient, ClientConfiguration } from 'aws-sdk/clients/dynamodb'
import { ApiGatewayManagementApi, AWSError } from 'aws-sdk'

const AWS_REGION = process.env.AWS_REGION || 'us-east-1'
const TABLE_NAME = process.env.TABLE_NAME || 'Database'

const DynamoDBOptions: ClientConfiguration = {
  region: AWS_REGION || 'us-east-1',
}
const awsEndpoint = process.env.AWS_DYNAMODB_ENDPOINT
if (awsEndpoint) {
  DynamoDBOptions.endpoint = awsEndpoint
}

if (process.env.JEST_WORKER_ID) {
  DynamoDBOptions.endpoint = process.env.MOCK_DYNAMODB_ENDPOINT
  DynamoDBOptions.sslEnabled = false
  DynamoDBOptions.region = 'local'
}

const Database = new DocumentClient(DynamoDBOptions)

class InvalidTopicError extends Error {}

const assertTopic = (topic: string) => {
  if (topic.length > 100) {
    throw new InvalidTopicError('Topic name too long')
  }
  if (!topic.match(/^[a-zA-Z0-9_-]+$/)) {
    throw new InvalidTopicError('Topic name contains invalid characters')
  }
}

async function subscribe(topic: string, connectionId: string) {
  assertTopic(topic)

  const params = {
    TableName: TABLE_NAME,
    Item: {
      pk: `TOPIC-${topic}`,
      sk: `CONNECTION-${connectionId}`,
      data: `0`,
    },
  }
  await Database.put(params)
    .promise()
    .catch((err) => {
      console.log(`Cannot subscribe to topic ${topic}: ${err.message}`)
    })
}

async function unsubscribe(topic: string, connectionId: string) {
  assertTopic(topic)

  const params: DocumentClient.DeleteItemInput = {
    TableName: TABLE_NAME,
    Key: {
      pk: `TOPIC-${topic}`,
      sk: `CONNECTION-${connectionId}`,
    },
  }
  await Database.delete(params)
    .promise()
    .catch((err) => {
      console.log(`Cannot unsubscribe from topic ${topic}: ${err.message}`)
    })
}

async function unsubscribeAll(connectionId: string) {
  const topics = await getTopics(connectionId)
  const promises: Promise<unknown>[] = []
  for (const topic of topics) {
    promises.push(unsubscribe(topic, connectionId))
  }
  await Promise.all(promises)
}

async function getSubscribers(topic: string) {
  assertTopic(topic)

  try {
    const params = {
      TableName: 'Database',
      ExpressionAttributeValues: {
        ':p': `TOPIC-${topic}`,
        ':s': 'CONNECTION-',
      },
      KeyConditionExpression: 'pk = :p and begins_with(sk, :s)',
    }
    const subscribers = await Database.query(params).promise()
    if (!subscribers.Items || subscribers.Items.length === 0) return []
    const connectionIds = subscribers.Items.map((item) => {
      return item.sk.replace('CONNECTION-', '')
    })
    return connectionIds
  } catch (error: unknown) {
    console.log(`Cannot get subscribers for topic ${topic}: ${(error as Error).message}`)
    return []
  }
}

async function getTopics(connectionId: string) {
  try {
    const params = {
      TableName: 'Database',
      IndexName: 'gs1',
      ExpressionAttributeValues: {
        ':s': `CONNECTION-${connectionId}`,
      },
      KeyConditionExpression: 'sk = :s',
    }
    const topics = await Database.query(params).promise()
    if (!topics.Items || topics.Items.length === 0) return []
    const topicIds = topics.Items.map((item) => {
      return item.pk.replace('TOPIC-', '')
    })
    return topicIds
  } catch (error: unknown) {
    console.log(`Cannot get topics for subscriber ${connectionId}: ${(error as Error).message}`)
    return []
  }
}

export async function handleConnect(connectionId: string): Promise<void> {
  console.log(`Connected: ${connectionId}`)
}

// When a client disconnects, we need to clean up the connection and notify all of the other clients.
// This is not guaranteed to be called, so we also need to handle stale connections when sending messages.
export async function handleDisconnect(connectionId: string): Promise<void> {
  console.log(`Disconnected: ${connectionId}`)
  await unsubscribeAll(connectionId)
}

// We need to set up a handler for messages, generally we use this to forward messages to other peers
// and handle the signaling handshake. The message is expected to be a JSON object with a type field
// that indicates what kind of message it is.
//
// Valid types:
//
// - offer:     When the peers that are in the room receive the new client's "ready" message, they will
//              each send an offer message to the new client (message[sid]). This is the first step in
//              the WebRTC signaling handshake. This message will be forwarded to the new client.
// - answer:    When the client receives an offer message, it will create a client side Peer object and
//              send an answer message back to the client that sent the offer. This answer message
//              will be forwarded to the peer that sent the offer (message[sid]).
// - candidate: Once the offer and answer are exchanged, the peers will exchange ICE candidates, these
//              are broadcast to all peers in the room.
export async function handleMessage(
  connectionId: string,
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-explicit-any
  message: any,
  send: (receiverConnectionId: string, message: string) => Promise<void>,
): Promise<void> {
  if (message && message.type) {
    switch (message.type) {
      case 'subscribe':
        const room = message.room
        await subscribe(room, connectionId)

        // Now that this client is connected, tell all of the other clients that this client is ready
        // and send them this client's connectionId so they can setup the signaling handshake.
        const readyMessage = JSON.stringify({ type: 'ready', sid: connectionId })
        const receivers = await getSubscribers(room)
        const promises: Promise<unknown>[] = []
        for (let i = 0; i < receivers.length; i++) {
          if (receivers[i] === connectionId) continue
          promises.push(send(receivers[i], readyMessage))
        }
        await Promise.all(promises)
        break
      case 'unsubscribe':
        await unsubscribeAll(connectionId)
        break
      case 'offer':
      case 'answer':
      case 'candidate':
        let peerToForwardTo = undefined
        if (message['sid']) {
          peerToForwardTo = message['sid']
        }
        message['sid'] = connectionId
        if (peerToForwardTo) {
          await send(peerToForwardTo, JSON.stringify(message))
        } else {
          // Broadcast it to all peers in the room, except self
          const broadcastMessage = JSON.stringify(message)
          const topics = await getTopics(connectionId)
          const promises: Promise<unknown>[] = []
          for (const topic of topics) {
            const receivers = await getSubscribers(topic)
            for (let i = 0; i < receivers.length; i++) {
              if (receivers[i] === connectionId) continue
              promises.push(send(receivers[i], broadcastMessage))
            }
          }
          await Promise.all(promises)
        }
        break
    }
  }
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const endpoint = `https://${event.requestContext.apiId}.execute-api.${AWS_REGION}.amazonaws.com/${event.requestContext.stage}`

  // The AWS "simple chat" example uses event.requestContext.domainName/...stage, but that doesn't work with custom domain
  // names. It also doesn't matter, this is anyways an internal (AWS->AWS) call.
  const apigwManagementApi = new ApiGatewayManagementApi({
    apiVersion: '2018-11-29',
    endpoint,
  })

  const send = async (connectionId: string, message: string) => {
    try {
      await apigwManagementApi
        .postToConnection({
          ConnectionId: connectionId,
          Data: message,
        })
        .promise()
    } catch (error: unknown) {
      if ((error as AWSError).statusCode === 410) {
        console.log(`Found stale connection, deleting ${connectionId}`)
        await handleDisconnect(connectionId)
      } else {
        // Log, but otherwise ignore: There's not much we can do, really.
        console.log(`Error when sending to ${connectionId}: ${(error as Error).message}`)
      }
    }
  }

  if (!event.requestContext.connectionId) {
    return {
      statusCode: 400,
      body: 'Missing connectionId',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/plain',
      },
    }
  }

  try {
    switch (event.requestContext.routeKey) {
      case '$connect':
        await handleConnect(event.requestContext.connectionId)
        break
      case '$disconnect':
        await handleDisconnect(event.requestContext.connectionId)
        break
      case '$default':
      default:
        await handleMessage(event.requestContext.connectionId, JSON.parse(event.body || '{}'), send)
        break
    }

    return {
      statusCode: 200,
      body: 'ok',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/plain',
      },
    }
  } catch (error: unknown) {
    console.log(`Error ${event.requestContext.connectionId}`, error)
    return {
      statusCode: 500,
      body: (error as Error).message,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/plain',
      },
    }
  }
}
