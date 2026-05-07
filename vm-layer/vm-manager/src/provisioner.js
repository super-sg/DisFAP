/**
 * ============================================================================
 * VM Manager — Provisioner
 * ============================================================================
 * 
 * Wraps AWS EC2 SDK to provision, query, and destroy ephemeral session VMs.
 * This module replaces direct Terraform CLI calls with the AWS SDK for faster
 * provisioning and finer-grained control.
 * 
 * Lifecycle:
 *   provisionVM() → getVMStatus() → destroyVM()
 */

const {
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
  DescribeInstanceStatusCommand,
  CreateTagsCommand,
  waitUntilInstanceRunning,
} = require('@aws-sdk/client-ec2');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const winston = require('winston');
const config = require('./config');

// ── Logger ────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: config.server.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'provisioner' },
  transports: [new winston.transports.Console()],
});

// ── EC2 Client ────────────────────────────────────────────────────────────
const ec2Client = new EC2Client({ region: config.aws.region });

// ── In-memory session store (replace with Redis/DB in production) ─────────
const sessions = new Map();

/**
 * Generates a cryptographically secure random password.
 * @param {number} length - Password length (default: 24)
 * @returns {string} Random password
 */
function generatePassword(length = 24) {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  const bytes = crypto.randomBytes(length);
  let password = '';
  for (let i = 0; i < length; i++) {
    password += charset[bytes[i] % charset.length];
  }
  return password;
}

/**
 * Builds the user data script for dynamic password injection.
 * @param {string} osType - 'windows' or 'linux'
 * @param {string} username - Session username
 * @param {string} password - Generated session password
 * @param {string} sessionId - Session identifier
 * @param {string} userId - User identifier
 * @returns {string} Base64-encoded user data script
 */
function buildUserData(osType, username, password, sessionId, userId) {
  let script;

  if (osType === 'windows') {
    script = `<powershell>
$username = "${username}"
$password = ConvertTo-SecureString "${password}" -AsPlainText -Force
Set-LocalUser -Name $username -Password $password
Disable-LocalUser -Name "Administrator"
Write-Output "SESSION_READY" | Out-File -FilePath C:\\session-ready.txt
</powershell>`;
  } else {
    script = `#!/bin/bash
set -euo pipefail
echo "${username}:${password}" | chpasswd
su - ${username} -c "mkdir -p ~/.vnc && echo '${password}' | vncpasswd -f > ~/.vnc/passwd && chmod 600 ~/.vnc/passwd"
systemctl start vncserver@1.service
echo "SESSION_READY" > /tmp/session-ready.txt
logger -t session-manager "Session started: id=${sessionId} user=${userId}"`;
  }

  return Buffer.from(script).toString('base64');
}

/**
 * Provisions a new ephemeral VM for a software sharing session.
 * 
 * @param {Object} sessionConfig
 * @param {string} sessionConfig.userId - ID of the requesting user
 * @param {string} sessionConfig.softwareType - Type of software to share
 * @param {string} [sessionConfig.osType='windows'] - 'windows' or 'linux'
 * @param {string} [sessionConfig.instanceType] - EC2 instance type override
 * @param {number} [sessionConfig.ttlMinutes] - Session duration in minutes
 * 
 * @returns {Object} Session info including sessionId, instanceId, connection details
 */
async function provisionVM(sessionConfig) {
  const {
    userId,
    softwareType,
    osType = 'windows',
    instanceType = config.vm.defaultInstanceType,
    ttlMinutes = config.session.defaultTtlMinutes,
  } = sessionConfig;

  // Validate TTL
  if (ttlMinutes > config.session.maxTtlMinutes) {
    throw new Error(`TTL exceeds maximum allowed (${config.session.maxTtlMinutes} minutes)`);
  }

  // Check concurrent VM limit
  const activeCount = await getActiveSessionCount(userId);
  if (activeCount >= config.session.maxConcurrentVms) {
    throw new Error(`Maximum concurrent VMs reached (${config.session.maxConcurrentVms})`);
  }

  const sessionId = `sess-${uuidv4().slice(0, 8)}`;
  const sessionPassword = generatePassword();
  const amiId = osType === 'windows' ? config.vm.windowsAmiId : config.vm.linuxAmiId;

  if (!amiId) {
    throw new Error(`No AMI configured for OS type: ${osType}`);
  }

  const ttlExpiry = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

  logger.info('Provisioning VM', { sessionId, userId, osType, instanceType, ttlMinutes });

  try {
    // Launch the EC2 instance
    const runCommand = new RunInstancesCommand({
      ImageId: amiId,
      InstanceType: instanceType,
      MinCount: 1,
      MaxCount: 1,
      SubnetId: config.vm.subnetId,
      SecurityGroupIds: config.vm.securityGroupIds,
      IamInstanceProfile: config.vm.instanceProfileName
        ? { Name: config.vm.instanceProfileName }
        : undefined,
      UserData: buildUserData(osType, config.session.sessionUsername, sessionPassword, sessionId, userId),
      MetadataOptions: {
        HttpEndpoint: 'enabled',
        HttpTokens: 'required', // Enforce IMDSv2
        HttpPutResponseHopLimit: 1,
      },
      BlockDeviceMappings: [
        {
          DeviceName: osType === 'windows' ? '/dev/sda1' : '/dev/xvda',
          Ebs: {
            VolumeSize: 100,
            VolumeType: 'gp3',
            Encrypted: true,
            KmsKeyId: config.vm.kmsKeyId || undefined,
            DeleteOnTermination: true,
          },
        },
      ],
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: [
            { Key: 'Name', Value: `software-sharing-session-${sessionId}` },
            { Key: 'Project', Value: 'software-sharing' },
            { Key: 'SessionId', Value: sessionId },
            { Key: 'UserId', Value: userId },
            { Key: 'SoftwareType', Value: softwareType },
            { Key: 'TTLExpiry', Value: ttlExpiry },
            { Key: 'SessionStatus', Value: 'provisioning' },
            { Key: 'AutoDestroy', Value: 'true' },
            { Key: 'CreatedAt', Value: new Date().toISOString() },
          ],
        },
      ],
      InstanceInitiatedShutdownBehavior: 'terminate',
    });

    const result = await ec2Client.send(runCommand);
    const instanceId = result.Instances[0].InstanceId;

    logger.info('Instance launched, waiting for running state', { sessionId, instanceId });

    // Wait for the instance to be in 'running' state
    await waitUntilInstanceRunning(
      { client: ec2Client, maxWaitTime: 300 },
      { InstanceIds: [instanceId] }
    );

    // Get the private IP
    const describeResult = await ec2Client.send(
      new DescribeInstancesCommand({ InstanceIds: [instanceId] })
    );
    const instance = describeResult.Reservations[0].Instances[0];
    const privateIp = instance.PrivateIpAddress;

    // Update the session status tag
    await ec2Client.send(
      new CreateTagsCommand({
        Resources: [instanceId],
        Tags: [{ Key: 'SessionStatus', Value: 'ready' }],
      })
    );

    // Store session info
    const sessionInfo = {
      sessionId,
      instanceId,
      userId,
      softwareType,
      osType,
      instanceType,
      privateIp,
      port: osType === 'windows' ? 3389 : 5901,
      protocol: osType === 'windows' ? 'rdp' : 'vnc',
      username: config.session.sessionUsername,
      password: sessionPassword,
      ttlMinutes,
      ttlExpiry,
      status: 'ready',
      createdAt: new Date().toISOString(),
    };

    sessions.set(sessionId, sessionInfo);

    logger.info('VM provisioned successfully', {
      sessionId,
      instanceId,
      privateIp,
      protocol: sessionInfo.protocol,
    });

    // Return session info (without password for the response)
    const { password, ...safeSessionInfo } = sessionInfo;
    return safeSessionInfo;

  } catch (error) {
    logger.error('Failed to provision VM', { sessionId, error: error.message });
    throw error;
  }
}

/**
 * Retrieves the current status of a session VM.
 * 
 * @param {string} sessionId - The session identifier
 * @returns {Object} Session status including instance state
 */
async function getVMStatus(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  try {
    const result = await ec2Client.send(
      new DescribeInstancesCommand({ InstanceIds: [session.instanceId] })
    );

    if (!result.Reservations.length || !result.Reservations[0].Instances.length) {
      session.status = 'terminated';
      sessions.set(sessionId, session);
      return { ...session, instanceState: 'terminated' };
    }

    const instance = result.Reservations[0].Instances[0];
    const instanceState = instance.State.Name;

    // Update local status based on instance state
    if (instanceState === 'terminated' || instanceState === 'shutting-down') {
      session.status = 'terminated';
    } else if (instanceState === 'running') {
      session.status = session.status === 'provisioning' ? 'ready' : session.status;
    }

    sessions.set(sessionId, session);

    return {
      sessionId: session.sessionId,
      instanceId: session.instanceId,
      userId: session.userId,
      softwareType: session.softwareType,
      privateIp: session.privateIp,
      protocol: session.protocol,
      port: session.port,
      status: session.status,
      instanceState,
      ttlExpiry: session.ttlExpiry,
      createdAt: session.createdAt,
    };
  } catch (error) {
    logger.error('Failed to get VM status', { sessionId, error: error.message });
    throw error;
  }
}

/**
 * Destroys a session VM and cleans up resources.
 * 
 * @param {string} sessionId - The session identifier
 * @returns {Object} Destruction confirmation
 */
async function destroyVM(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  logger.info('Destroying VM', { sessionId, instanceId: session.instanceId });

  try {
    // Update tag to reflect terminating status
    await ec2Client.send(
      new CreateTagsCommand({
        Resources: [session.instanceId],
        Tags: [{ Key: 'SessionStatus', Value: 'terminating' }],
      })
    );

    // Terminate the instance
    await ec2Client.send(
      new TerminateInstancesCommand({ InstanceIds: [session.instanceId] })
    );

    session.status = 'terminated';
    session.terminatedAt = new Date().toISOString();
    sessions.set(sessionId, session);

    logger.info('VM destroyed successfully', { sessionId, instanceId: session.instanceId });

    return {
      sessionId,
      instanceId: session.instanceId,
      status: 'terminated',
      terminatedAt: session.terminatedAt,
    };
  } catch (error) {
    logger.error('Failed to destroy VM', { sessionId, error: error.message });
    throw error;
  }
}

/**
 * Gets the count of active (non-terminated) sessions for a user.
 * @param {string} userId
 * @returns {number}
 */
async function getActiveSessionCount(userId) {
  let count = 0;
  for (const [, session] of sessions) {
    if (session.userId === userId && session.status !== 'terminated') {
      count++;
    }
  }
  return count;
}

/**
 * Returns all active sessions (for lifecycle manager).
 * @returns {Array<Object>}
 */
function getActiveSessions() {
  const active = [];
  for (const [, session] of sessions) {
    if (session.status !== 'terminated') {
      active.push(session);
    }
  }
  return active;
}

/**
 * Returns the full session info including password (for Guacamole token generation).
 * @param {string} sessionId
 * @returns {Object|null}
 */
function getSessionWithCredentials(sessionId) {
  return sessions.get(sessionId) || null;
}

module.exports = {
  provisionVM,
  getVMStatus,
  destroyVM,
  getActiveSessions,
  getSessionWithCredentials,
  getActiveSessionCount,
  // Exported for testing
  generatePassword,
  buildUserData,
};
