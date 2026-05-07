/**
 * ============================================================================
 * VM Manager — Express HTTP API
 * ============================================================================
 * 
 * Entry point for the VM Manager service.
 * Exposes REST endpoints for provisioning, monitoring, and destroying VMs.
 * 
 * Endpoints:
 *   POST   /api/vm/provision          — Provision a new session VM
 *   GET    /api/vm/:sessionId/status  — Get VM status
 *   DELETE /api/vm/:sessionId         — Destroy a session VM
 *   GET    /api/vm/:sessionId/connect — Get Guacamole connection URL
 *   GET    /api/vm/health             — Service health check
 * 
 * Usage:
 *   npm start     (production)
 *   npm run dev   (development with auto-reload)
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const winston = require('winston');
const config = require('./config');
const { provisionVM, getVMStatus, destroyVM, getSessionWithCredentials } = require('./provisioner');
const { startLifecycleManager, stopLifecycleManager } = require('./lifecycle');
const { createGuacamoleSession } = require('./connection-builder');

// ── Logger ────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: config.server.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'vm-manager-api' },
  transports: [new winston.transports.Console()],
});

// ── Express App ───────────────────────────────────────────────────────────
const app = express();

// Middleware
app.use(helmet());                                  // Security headers
app.use(cors());                                    // CORS for frontend
app.use(express.json());                            // JSON body parsing
app.use(morgan('combined', {                        // HTTP request logging
  stream: { write: (msg) => logger.info(msg.trim()) }
}));

// ── Routes ────────────────────────────────────────────────────────────────

/**
 * POST /api/vm/provision
 * Provision a new session VM.
 * 
 * Request Body:
 *   {
 *     "userId": "user-123",
 *     "softwareType": "adobe-cc",
 *     "osType": "windows",           // optional, default: "windows"
 *     "instanceType": "t3.large",    // optional
 *     "ttlMinutes": 240              // optional, default: 240
 *   }
 * 
 * Response:
 *   {
 *     "success": true,
 *     "session": { sessionId, instanceId, privateIp, protocol, ... }
 *   }
 */
app.post('/api/vm/provision', async (req, res) => {
  try {
    const { userId, softwareType, osType, instanceType, ttlMinutes } = req.body;

    // Validate required fields
    if (!userId || !softwareType) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userId, softwareType',
      });
    }

    logger.info('Provision request received', { userId, softwareType, osType });

    const session = await provisionVM({
      userId,
      softwareType,
      osType,
      instanceType,
      ttlMinutes,
    });

    res.status(201).json({ success: true, session });

  } catch (error) {
    logger.error('Provision failed', { error: error.message });
    const status = error.message.includes('Maximum concurrent') ? 429 : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/vm/:sessionId/status
 * Get the current status of a session VM.
 */
app.get('/api/vm/:sessionId/status', async (req, res) => {
  try {
    const status = await getVMStatus(req.params.sessionId);
    res.json({ success: true, status });
  } catch (error) {
    const statusCode = error.message.includes('not found') ? 404 : 500;
    res.status(statusCode).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/vm/:sessionId
 * Destroy a session VM and clean up resources.
 */
app.delete('/api/vm/:sessionId', async (req, res) => {
  try {
    logger.info('Destroy request received', { sessionId: req.params.sessionId });
    const result = await destroyVM(req.params.sessionId);
    res.json({ success: true, result });
  } catch (error) {
    const statusCode = error.message.includes('not found') ? 404 : 500;
    res.status(statusCode).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/vm/:sessionId/connect
 * Get a Guacamole connection URL for the session.
 * This triggers the JSON auth token flow.
 */
app.get('/api/vm/:sessionId/connect', async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const session = getSessionWithCredentials(sessionId);

    if (!session) {
      return res.status(404).json({
        success: false,
        error: `Session not found: ${sessionId}`,
      });
    }

    if (session.status !== 'ready' && session.status !== 'active') {
      return res.status(409).json({
        success: false,
        error: `Session is not ready. Current status: ${session.status}`,
      });
    }

    logger.info('Connect request received', { sessionId });

    const guacSession = await createGuacamoleSession(session);

    // Mark session as active
    session.status = 'active';

    res.json({
      success: true,
      connection: {
        connectionUrl: guacSession.connectionUrl,
        expiresAt: guacSession.expiresAt,
        protocol: session.protocol,
      },
    });

  } catch (error) {
    logger.error('Connect failed', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/vm/health
 * Service health check endpoint.
 */
app.get('/api/vm/health', (req, res) => {
  res.json({
    success: true,
    service: 'vm-manager',
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: config.server.env,
  });
});

// ── Error Handling ────────────────────────────────────────────────────────

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.path}`,
  });
});

// Global error handler
app.use((err, req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({
    success: false,
    error: config.server.env === 'production' ? 'Internal server error' : err.message,
  });
});

// ── Server Startup ────────────────────────────────────────────────────────

function startServer() {
  // Validate configuration
  try {
    config.validateConfig();
  } catch (error) {
    logger.error('Configuration validation failed', { error: error.message });
    process.exit(1);
  }

  const server = app.listen(config.server.port, () => {
    logger.info(`🚀 VM Manager started`, {
      port: config.server.port,
      environment: config.server.env,
      region: config.aws.region,
    });

    // Start the lifecycle manager
    startLifecycleManager();
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);
    stopLifecycleManager();
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });

    // Force shutdown after 30 seconds
    setTimeout(() => {
      logger.error('Forced shutdown after 30s timeout');
      process.exit(1);
    }, 30000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

// Start if running directly (not imported for testing)
if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
