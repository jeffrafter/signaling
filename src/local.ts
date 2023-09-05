import 'dotenv/config'
import { createServer, IncomingMessage } from 'http'
import ws, { RawData, WebSocket } from 'ws'
import { handleConnect, handleDisconnect, handleMessage } from './signaling'

const PORT = process.env.PORT || 4001
const server = createServer()

type WebSocketWithConnectionId = WebSocket & { connectionId: string }

const wss = new ws.Server({ noServer: true })

wss.on('connection', async (ws: ws, req: IncomingMessage) => {
  const sendToClient = async (receiverConnectionId: string, message: string): Promise<void> => {
    try {
      // Looping through all of the clients to find the client by connectionId is
      // inefficient but it allows us to mimic the AWS API Gateway send mechanism
      // more closely. Given that this is a local server meant as a development
      // tool, this is probably fine.
      for (const client of wss.clients) {
        if ((client as WebSocketWithConnectionId).connectionId === receiverConnectionId) {
          if (client.readyState === WebSocket.CLOSING || client.readyState === WebSocket.CLOSED) {
            // If the client is closing or closed, we need to clean up the connection
            await handleDisconnect(receiverConnectionId)
            return
          }
          if (client.readyState === WebSocket.OPEN) {
            console.log(`REALLY sending message to ${receiverConnectionId}`, { message })
            await client.send(message)
            return
          }
        }
      }
      // If we got through the loop and didn't find the client, we need to clean up the connection
      await handleDisconnect(receiverConnectionId)
    } catch (error: unknown) {
      // Log, but otherwise ignore: There's not much we can do, really.
      // In the future, we could add a retry mechanism here or disconnect the client.
      console.log(`Error when sending to ${receiverConnectionId}: ${(error as Error).message}`)
    }
  }

  // On AWS ApiGateway, this is the connectionId, but when running locally, we'll use the
  // sec-websocket-key header. We also need to set the connectionId on the ws object so we
  // can check it later.
  const connectionId = req.headers['sec-websocket-key'] as string
  ;(ws as WebSocketWithConnectionId).connectionId = connectionId

  ws.on('message', async (data: RawData) => {
    const message = JSON.parse(data.toString())
    await handleMessage(connectionId, message, sendToClient)
  })

  ws.on('close', async () => {
    await handleDisconnect(connectionId)
  })

  // TODO: should errors lead to disconnects?
  ws.on('error', async (error) => {
    console.error(`Error ${connectionId}, forcing disconnect`, error)
    await handleDisconnect(connectionId)
  })

  await handleConnect(connectionId)
})

// `server` is a vanilla Node.js HTTP server, so use the same ws upgrade process described here:
// https://github.com/websockets/ws#multiple-servers-sharing-a-single-https-server
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (socket) => {
    wss.emit('connection', socket, request)
  })
})

server.listen(PORT)
