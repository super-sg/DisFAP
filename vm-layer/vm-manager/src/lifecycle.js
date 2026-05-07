/**
 * ============================================================================
 * VM Manager — Lifecycle Manager
 * ============================================================================
 * 
 * Monitors and manages the lifecycle of ephemeral session VMs.
 * 
 * Responsibilities:
 *   - Health checks every 30 seconds
 *   - TTL enforcement (auto-destroy expired VMs)
 *   - Reaper cron (safety net for orphaned VMs)
 *   - Graceful shutdown warnings before TTL expiry
 * 
 * State Machine:
 *   PROVISIONING → READY → ACTIVE → IDLE → TERMINATING → TERMINATED
 *                    ↓                         ↑
 *                  FAILED ─────────────────────┘
 */

const { EC2Client, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
const winston = require('winston');
const config = require('./config');
const { destroyVM, getActiveSessions } = require('./provisioner');

// ── Logger ────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: config.server.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'lifecycle' },
  transports: [new winston.transports.Console()],
});

// ── EC2 Client ────────────────────────────────────────────────────────────
const ec2Client = new EC2Client({ region: config.aws.region });

// ── Interval Handles ──────────────────────────────────────────────────────
let healthCheckInterval = null;
let reaperInterval = null;

/**
 * Checks the health of all active session VMs.
 * Destroys VMs that are in an unhealthy state or have exceeded their TTL.
 */
async function runHealthChecks() {
  const activeSessions = getActiveSessions();

  if (activeSessions.length === 0) {
    return;
  }

  logger.debug(`Running health checks for ${activeSessions.length} active sessions`);

  for (const session of activeSessions) {
    try {
      await checkSession(session);
    } catch (error) {
      logger.error('Health check failed for session', {
        sessionId: session.sessionId,
        error: error.message,
      });
    }
  }
}

/**
 * Checks a single session's health and TTL.
 * @param {Object} session - Session object from provisioner
 */
async function checkSession(session) {
  const now = new Date();
  const ttlExpiry = new Date(session.ttlExpiry);

  // ── Check TTL Expiry ──────────────────────────────────────────────────
  if (now >= ttlExpiry) {
    logger.warn('Session TTL expired, destroying VM', {
      sessionId: session.sessionId,
      ttlExpiry: session.ttlExpiry,
    });
    await destroyVM(session.sessionId);
    return;
  }

  // ── Check TTL Warning ─────────────────────────────────────────────────
  const warningTime = new Date(ttlExpiry.getTime() - config.lifecycle.warningBeforeTtlMinutes * 60 * 1000);
  if (now >= warningTime && !session._warningSent) {
    logger.info('Session TTL expiring soon', {
      sessionId: session.sessionId,
      minutesRemaining: Math.round((ttlExpiry - now) / 60000),
    });
    // In production, emit an event or push notification to the user
    session._warningSent = true;
  }

  // ── Check EC2 Instance State ──────────────────────────────────────────
  try {
    const result = await ec2Client.send(
      new DescribeInstancesCommand({ InstanceIds: [session.instanceId] })
    );

    if (!result.Reservations.length || !result.Reservations[0].Instances.length) {
      logger.warn('Instance no longer exists, marking session terminated', {
        sessionId: session.sessionId,
      });
      session.status = 'terminated';
      return;
    }

    const instance = result.Reservations[0].Instances[0];
    const instanceState = instance.State.Name;

    // If instance terminated unexpectedly
    if (instanceState === 'terminated' || instanceState === 'shutting-down') {
      logger.warn('Instance terminated unexpectedly', {
        sessionId: session.sessionId,
        instanceState,
      });
      session.status = 'terminated';
      return;
    }

    // If instance stopped (shouldn't happen for ephemeral VMs)
    if (instanceState === 'stopped') {
      logger.warn('Instance stopped unexpectedly, destroying', {
        sessionId: session.sessionId,
      });
      await destroyVM(session.sessionId);
      return;
    }

    logger.debug('Session healthy', {
      sessionId: session.sessionId,
      instanceState,
      minutesRemaining: Math.round((ttlExpiry - now) / 60000),
    });

  } catch (error) {
    // If the instance doesn't exist, mark as terminated
    if (error.name === 'InvalidInstanceID.NotFound') {
      logger.warn('Instance not found, marking terminated', {
        sessionId: session.sessionId,
      });
      session.status = 'terminated';
    } else {
      throw error;
    }
  }
}

/**
 * Reaper function — scans for orphaned VMs that should have been destroyed.
 * Acts as a safety net in case the primary lifecycle manager missed a VM.
 * 
 * Scans for EC2 instances tagged with:
 *   - Project = "software-sharing"
 *   - AutoDestroy = "true"
 *   - TTLExpiry < now
 */
async function runReaper() {
  logger.info('Running reaper scan for orphaned VMs...');

  try {
    const result = await ec2Client.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: 'tag:Project', Values: ['software-sharing'] },
          { Name: 'tag:AutoDestroy', Values: ['true'] },
          { Name: 'instance-state-name', Values: ['running', 'stopped', 'pending'] },
        ],
      })
    );

    const now = new Date();
    let orphanCount = 0;

    for (const reservation of result.Reservations || []) {
      for (const instance of reservation.Instances || []) {
        const ttlTag = (instance.Tags || []).find(t => t.Key === 'TTLExpiry');
        if (!ttlTag) continue;

        const ttlExpiry = new Date(ttlTag.Value);
        if (now >= ttlExpiry) {
          const sessionIdTag = (instance.Tags || []).find(t => t.Key === 'SessionId');
          const sessionId = sessionIdTag ? sessionIdTag.Value : 'unknown';

          logger.warn('Reaper: Found orphaned VM past TTL', {
            instanceId: instance.InstanceId,
            sessionId,
            ttlExpiry: ttlTag.Value,
            overdueMins: Math.round((now - ttlExpiry) / 60000),
          });

          // Attempt graceful destroy through provisioner first
          try {
            await destroyVM(sessionId);
          } catch {
            // If session not in our store, terminate directly
            logger.warn('Reaper: Direct termination of orphaned instance', {
              instanceId: instance.InstanceId,
            });
            const { TerminateInstancesCommand } = require('@aws-sdk/client-ec2');
            await ec2Client.send(
              new TerminateInstancesCommand({ InstanceIds: [instance.InstanceId] })
            );
          }

          orphanCount++;
        }
      }
    }

    logger.info(`Reaper scan complete. Terminated ${orphanCount} orphaned VM(s).`);

  } catch (error) {
    logger.error('Reaper scan failed', { error: error.message });
  }
}

/**
 * Starts the lifecycle manager — begins health checks and reaper cron.
 */
function startLifecycleManager() {
  logger.info('Starting lifecycle manager', {
    healthCheckInterval: `${config.lifecycle.healthCheckIntervalMs}ms`,
    reaperInterval: `${config.lifecycle.reaperIntervalMs}ms`,
  });

  // Start health check loop
  healthCheckInterval = setInterval(runHealthChecks, config.lifecycle.healthCheckIntervalMs);

  // Start reaper cron
  reaperInterval = setInterval(runReaper, config.lifecycle.reaperIntervalMs);

  // Run an initial health check and reaper scan
  runHealthChecks();
  runReaper();
}

/**
 * Stops the lifecycle manager — clears all intervals.
 */
function stopLifecycleManager() {
  logger.info('Stopping lifecycle manager');

  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }

  if (reaperInterval) {
    clearInterval(reaperInterval);
    reaperInterval = null;
  }
}

module.exports = {
  startLifecycleManager,
  stopLifecycleManager,
  runHealthChecks,
  runReaper,
  // Exported for testing
  checkSession,
};
