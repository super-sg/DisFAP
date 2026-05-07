/**
 * ============================================================================
 * VM Manager — Guacamole Connection Builder
 * ============================================================================
 * 
 * Builds and signs JSON authentication tokens for Apache Guacamole.
 * These tokens allow the Orchestrator to grant session access without
 * exposing credentials to the end user.
 * 
 * Token Format:
 * {
 *   "username": "session-<id>",
 *   "expires": "<unix-timestamp-ms>",
 *   "connections": {
 *     "Session-VM": {
 *       "protocol": "rdp",
 *       "parameters": {
 *         "hostname": "<private-ip>",
 *         "port": "3389",
 *         "username": "session-user",
 *         "password": "<dynamic-password>",
 *         ...
 *       }
 *     }
 *   }
 * }
 * 
 * The token is:
 *   1. Serialized to JSON
 *   2. Signed with HMAC-SHA256 using a shared secret
 *   3. Base64-encoded
 *   4. POSTed to Guacamole's /api/tokens endpoint
 */

const CryptoJS = require('crypto-js');
const axios = require('axios');
const winston = require('winston');
const config = require('./config');

// ── Logger ────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: config.server.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'connection-builder' },
  transports: [new winston.transports.Console()],
});

/**
 * Builds a Guacamole JSON authentication token payload.
 * 
 * @param {Object} connectionInfo
 * @param {string} connectionInfo.sessionId - Session identifier
 * @param {string} connectionInfo.hostname - Private IP of the VM
 * @param {string} connectionInfo.port - RDP/VNC port
 * @param {string} connectionInfo.protocol - 'rdp' or 'vnc'
 * @param {string} connectionInfo.username - VM session username
 * @param {string} connectionInfo.password - VM session password
 * @param {number} [connectionInfo.ttlMinutes=240] - Token validity in minutes
 * 
 * @returns {Object} The unsigned token payload
 */
function buildTokenPayload(connectionInfo) {
  const {
    sessionId,
    hostname,
    port,
    protocol,
    username,
    password,
    ttlMinutes = config.session.defaultTtlMinutes,
  } = connectionInfo;

  // Token expires at the same time as the session TTL
  const expiresMs = Date.now() + ttlMinutes * 60 * 1000;

  // Build connection parameters based on protocol
  const parameters = protocol === 'rdp'
    ? buildRdpParameters(hostname, port, username, password)
    : buildVncParameters(hostname, port, password);

  const payload = {
    username: `session-${sessionId}`,
    expires: expiresMs.toString(),
    connections: {
      [`Session-${sessionId}`]: {
        protocol,
        parameters,
      },
    },
  };

  logger.debug('Built token payload', {
    sessionId,
    protocol,
    hostname,
    expires: new Date(expiresMs).toISOString(),
  });

  return payload;
}

/**
 * Builds RDP connection parameters for Guacamole.
 * Optimized for best visual quality while minimizing bandwidth.
 */
function buildRdpParameters(hostname, port, username, password) {
  return {
    hostname,
    port: port.toString(),
    username,
    password,

    // Security settings
    security: 'rdp',           // Match the VM's RDP security layer setting
    'ignore-cert': 'true',     // Accept self-signed certs on the VM
    'disable-auth': 'false',

    // Display optimization
    'color-depth': '24',
    'enable-font-smoothing': 'true',
    'enable-wallpaper': 'false',
    'enable-theming': 'true',
    'enable-full-window-drag': 'false',
    'enable-menu-animations': 'false',

    // Disable data transfer channels (security)
    'disable-audio': 'false',
    'enable-printing': 'false',
    'enable-drive': 'false',
    'disable-clipboard': 'true',  // Prevent credential leakage via clipboard

    // Resize behavior
    'resize-method': 'display-update',

    // Keyboard
    'server-layout': 'en-us-qwerty',
  };
}

/**
 * Builds VNC connection parameters for Guacamole.
 */
function buildVncParameters(hostname, port, password) {
  return {
    hostname,
    port: port.toString(),
    password,

    // Display
    'color-depth': '24',
    'cursor': 'remote',
    'swap-red-blue': 'false',

    // Clipboard (disabled for security)
    'disable-clipboard': 'true',

    // Audio
    'enable-audio': 'false',

    // Resize
    'autosize': 'true',
  };
}

/**
 * Signs a token payload with HMAC-SHA256 using the shared secret.
 * 
 * @param {Object} payload - The token payload to sign
 * @returns {string} Base64-encoded signed token (payload + signature)
 */
function signToken(payload) {
  const secretKey = config.guacamole.secretKey;
  if (!secretKey) {
    throw new Error('Guacamole secret key not configured (GUACAMOLE_SECRET_KEY)');
  }

  // Serialize the payload to JSON
  const jsonPayload = JSON.stringify(payload);

  // Create HMAC-SHA256 signature
  const signature = CryptoJS.HmacSHA256(jsonPayload, secretKey);

  // Encode: signature bytes + payload bytes → Base64
  // Guacamole expects: Base64( HMAC_SHA256(json) + json_bytes )
  const signatureBytes = CryptoJS.enc.Hex.parse(signature.toString());
  const payloadBytes = CryptoJS.enc.Utf8.parse(jsonPayload);
  const combined = signatureBytes.concat(payloadBytes);
  const signedToken = CryptoJS.enc.Base64.stringify(combined);

  logger.debug('Token signed successfully', {
    payloadSize: jsonPayload.length,
    tokenSize: signedToken.length,
  });

  return signedToken;
}

/**
 * Posts the signed token to Guacamole's /api/tokens endpoint to create a session.
 * 
 * @param {string} signedToken - The Base64-encoded signed token
 * @returns {Object} Guacamole response with authToken and redirect URL
 */
async function postTokenToGuacamole(signedToken) {
  const guacamoleUrl = config.guacamole.url;
  const tokenEndpoint = `${guacamoleUrl}/api/tokens`;

  logger.info('Posting token to Guacamole', { endpoint: tokenEndpoint });

  try {
    const response = await axios.post(
      tokenEndpoint,
      `data=${encodeURIComponent(signedToken)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000, // 10 second timeout
      }
    );

    logger.info('Guacamole token created successfully', {
      authToken: response.data.authToken ? '***' : 'missing',
    });

    return response.data;

  } catch (error) {
    const status = error.response?.status;
    const message = error.response?.data || error.message;
    logger.error('Failed to post token to Guacamole', { status, message });
    throw new Error(`Guacamole token creation failed: ${status} - ${JSON.stringify(message)}`);
  }
}

/**
 * Full pipeline: Build token → Sign → Post to Guacamole → Return connection URL.
 * 
 * @param {Object} sessionData - Session data from the provisioner
 * @returns {Object} { authToken, connectionUrl }
 */
async function createGuacamoleSession(sessionData) {
  const {
    sessionId,
    privateIp,
    port,
    protocol,
    username,
    password,
    ttlMinutes,
  } = sessionData;

  logger.info('Creating Guacamole session', { sessionId, protocol });

  // Step 1: Build the token payload
  const payload = buildTokenPayload({
    sessionId,
    hostname: privateIp,
    port,
    protocol,
    username,
    password,
    ttlMinutes,
  });

  // Step 2: Sign the token
  const signedToken = signToken(payload);

  // Step 3: Post to Guacamole
  const guacResponse = await postTokenToGuacamole(signedToken);

  // Step 4: Build the connection URL
  const connectionUrl = `${config.guacamole.url}/#/client/${encodeURIComponent(
    `Session-${sessionId}\0c\0DEFAULT`
  )}?token=${guacResponse.authToken}`;

  logger.info('Guacamole session created', { sessionId, connectionUrl: '***' });

  return {
    authToken: guacResponse.authToken,
    connectionUrl,
    expiresAt: new Date(parseInt(payload.expires, 10)).toISOString(),
  };
}

module.exports = {
  buildTokenPayload,
  signToken,
  postTokenToGuacamole,
  createGuacamoleSession,
  // Exported for testing
  buildRdpParameters,
  buildVncParameters,
};
