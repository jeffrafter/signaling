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

// Message structure and protocol flow taken from y-webrtc/bin/server.js
interface YWebRtcSubscriptionMessage {
  type: 'subscribe' | 'unsubscribe'
  topics?: string[]
}
interface YWebRtcPingMessage {
  type: 'ping'
}
interface YWebRtcPublishMessage {
  type: 'publish'
  topic?: string
  [k: string]: unknown
}

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
    },
  }
  return Database.put(params)
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
  return Database.delete(params)
    .promise()
    .catch((err) => {
      console.log(`Cannot unsubscribe from topic ${topic}: ${err.message}`)
    })
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

async function handleYWebRtcMessage(
  connectionId: string,
  message: YWebRtcSubscriptionMessage | YWebRtcPublishMessage | YWebRtcPingMessage,
  send: (receiver: string, message: unknown) => Promise<void>,
) {
  const promises: Promise<unknown>[] = []

  if (message && message.type) {
    switch (message.type) {
      case 'subscribe':
        ;(message.topics || []).forEach((topic) => {
          promises.push(subscribe(topic, connectionId))
        })
        break
      case 'unsubscribe':
        ;(message.topics || []).forEach((topic) => {
          promises.push(unsubscribe(topic, connectionId))
        })
        break
      case 'publish':
        if (message.topic) {
          const receivers = await getSubscribers(message.topic)
          receivers.forEach((receiver) => {
            promises.push(send(receiver, message))
          })
        }
        break
      case 'ping':
        promises.push(send(connectionId, { type: 'pong' }))
        break
    }
  }

  await Promise.all(promises)
}

function handleConnect(connectionId: string) {
  // Nothing to do
  console.log(`Connected: ${connectionId}`)
}

async function handleDisconnect(connectionId: string) {
  console.log(`Disconnected: ${connectionId}`)
  // Remove the connection from all topics
  const topics = await getTopics(connectionId)
  const promises: Promise<unknown>[] = []
  for (const topic of topics) {
    promises.push(unsubscribe(topic, connectionId))
  }
  await Promise.all(promises)
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const endpoint = `https://${event.requestContext.apiId}.execute-api.${AWS_REGION}.amazonaws.com/${event.requestContext.stage}`

  // The AWS "simple chat" example uses event.requestContext.domainName/...stage, but that doesn't work with custom domain
  // names. It also doesn't matter, this is anyways an internal (AWS->AWS) call.
  const apigwManagementApi = new ApiGatewayManagementApi({
    apiVersion: '2018-11-29',
    endpoint,
  })

  const send = async (connectionId: string, message: unknown) => {
    try {
      await apigwManagementApi
        .postToConnection({
          ConnectionId: connectionId,
          Data: JSON.stringify(message),
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
        handleConnect(event.requestContext.connectionId)
        break
      case '$disconnect':
        await handleDisconnect(event.requestContext.connectionId)
        break
      case '$default':
      default:
        await handleYWebRtcMessage(event.requestContext.connectionId, JSON.parse(event.body || '{}'), send)
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
