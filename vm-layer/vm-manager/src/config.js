/**
 * ============================================================================
 * VM Manager — Configuration Loader
 * ============================================================================
 * 
 * Loads configuration from environment variables with sensible defaults.
 * Supports .env files in development and AWS SSM Parameter Store in production.
 * 
 * Usage:
 *   const config = require('./config');
 *   console.log(config.aws.region);
 */

require('dotenv').config();

const config = {
  // ── Server ──────────────────────────────────────────────────────────────
  server: {
    port: parseInt(process.env.PORT, 10) || 3001,
    env: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
  },

  // ── AWS ─────────────────────────────────────────────────────────────────
  aws: {
    region: process.env.AWS_REGION || 'us-east-1',
    profile: process.env.AWS_PROFILE || undefined,
  },

  // ── VM Configuration ───────────────────────────────────────────────────
  vm: {
    windowsAmiId: process.env.WINDOWS_AMI_ID || '',
    linuxAmiId: process.env.LINUX_AMI_ID || '',
    defaultInstanceType: process.env.DEFAULT_INSTANCE_TYPE || 't3.large',
    subnetId: process.env.SUBNET_ID || '',
    securityGroupIds: (process.env.SECURITY_GROUP_IDS || '').split(',').filter(Boolean),
    instanceProfileName: process.env.INSTANCE_PROFILE_NAME || '',
    kmsKeyId: process.env.KMS_KEY_ID || '',
    useSpotInstances: process.env.USE_SPOT_INSTANCES === 'true',
  },

  // ── Session ─────────────────────────────────────────────────────────────
  session: {
    defaultTtlMinutes: parseInt(process.env.DEFAULT_TTL_MINUTES, 10) || 240,
    maxTtlMinutes: parseInt(process.env.MAX_TTL_MINUTES, 10) || 720,
    maxConcurrentVms: parseInt(process.env.MAX_CONCURRENT_VMS, 10) || 5,
    sessionUsername: process.env.SESSION_USERNAME || 'session-user',
  },

  // ── Lifecycle ───────────────────────────────────────────────────────────
  lifecycle: {
    healthCheckIntervalMs: parseInt(process.env.HEALTH_CHECK_INTERVAL_MS, 10) || 30000,
    reaperIntervalMs: parseInt(process.env.REAPER_INTERVAL_MS, 10) || 300000,
    idleTimeoutMinutes: parseInt(process.env.IDLE_TIMEOUT_MINUTES, 10) || 15,
    warningBeforeTtlMinutes: parseInt(process.env.WARNING_BEFORE_TTL_MINUTES, 10) || 5,
  },

  // ── Guacamole ───────────────────────────────────────────────────────────
  guacamole: {
    url: process.env.GUACAMOLE_URL || 'http://localhost:8080/guacamole',
    secretKey: process.env.GUACAMOLE_SECRET_KEY || '',
  },

  // ── CloudWatch ──────────────────────────────────────────────────────────
  cloudwatch: {
    configParam: process.env.CLOUDWATCH_CONFIG_PARAM || '/software-sharing/cloudwatch/config',
  },
};

/**
 * Validates that all required configuration values are present.
 * Throws an error if critical configuration is missing.
 */
function validateConfig() {
  const required = [
    { path: 'guacamole.secretKey', value: config.guacamole.secretKey },
  ];

  // Only validate cloud resources in production
  if (config.server.env === 'production') {
    required.push(
      { path: 'vm.windowsAmiId', value: config.vm.windowsAmiId },
      { path: 'vm.subnetId', value: config.vm.subnetId },
      { path: 'vm.securityGroupIds', value: config.vm.securityGroupIds.length > 0 ? 'ok' : '' },
      { path: 'vm.instanceProfileName', value: config.vm.instanceProfileName },
    );
  }

  const missing = required.filter(r => !r.value);
  if (missing.length > 0) {
    const missingPaths = missing.map(m => m.path).join(', ');
    throw new Error(`Missing required configuration: ${missingPaths}. Check your .env file.`);
  }
}

module.exports = { ...config, validateConfig };
