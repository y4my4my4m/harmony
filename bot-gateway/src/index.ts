import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import helmet from 'helmet'
import cors from 'cors'
import compression from 'compression'
import { config } from './config/supabase.js'
import { WebSocketGateway } from './gateway/WebSocketGateway.js'
import { EventDispatcher } from './gateway/EventDispatcher.js'
import { BotRestAPI } from './api/BotRestAPI.js'

// Create Express app
const app = express()

// Middleware
app.use(helmet())
app.use(cors())
app.use(compression())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  })
})

// Bot API routes
const botAPI = new BotRestAPI()
app.use('/api/v1', botAPI.router)

// Create HTTP server
const server = createServer(app)

// Create WebSocket server
const wss = new WebSocketServer({ 
  server, 
  path: '/gateway'
})

// Initialize services
const gateway = new WebSocketGateway(wss)
const eventDispatcher = new EventDispatcher(gateway)

// Start event dispatcher
eventDispatcher.start().catch(error => {
  console.error('❌ Failed to start event dispatcher:', error)
  process.exit(1)
})

// Status endpoint
app.get('/api/v1/gateway/status', (req, res) => {
  res.json({
    connected_bots: gateway.getConnectedBotCount(),
    total_connections: gateway.getTotalConnectionCount(),
    bots: gateway.getConnectedBots().map(b => ({
      id: b.botId,
      username: b.username,
      last_heartbeat: b.lastHeartbeat
    }))
  })
})

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err)
  res.status(500).json({
    error: 'Internal server error',
    message: config.nodeEnv === 'development' ? err.message : undefined
  })
})

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// Graceful shutdown
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

async function shutdown() {
  console.log('📥 Received shutdown signal')
  
  // Close WebSocket connections
  gateway.shutdown()
  
  // Close event dispatcher
  await eventDispatcher.shutdown()
  
  // Close HTTP server
  server.close(() => {
    console.log('👋 Server shut down gracefully')
    process.exit(0)
  })
  
  // Force close after 10 seconds
  setTimeout(() => {
    console.error('⚠️ Forced shutdown after timeout')
    process.exit(1)
  }, 10000)
}

// Start server
const PORT = config.port
server.listen(PORT, () => {
  console.log('╔════════════════════════════════════════╗')
  console.log('║   🤖 Harmony Bot Gateway Started      ║')
  console.log('╠════════════════════════════════════════╣')
  console.log(`║   HTTP Server:  http://localhost:${PORT}   ║`)
  console.log(`║   WebSocket:    ws://localhost:${PORT}/gateway`)
  console.log(`║   Environment:  ${config.nodeEnv.padEnd(23)}║`)
  console.log('╚════════════════════════════════════════╝')
})

// Unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason)
})

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error)
  process.exit(1)
})

export { app, server, gateway, eventDispatcher }

