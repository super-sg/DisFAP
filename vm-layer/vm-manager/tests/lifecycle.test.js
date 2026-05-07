/**
 * ============================================================================
 * Unit Tests — Lifecycle Manager
 * ============================================================================
 */

const { checkSession } = require('../src/lifecycle');

// Mock the EC2 client
jest.mock('@aws-sdk/client-ec2', () => {
  const mockSend = jest.fn();
  return {
    EC2Client: jest.fn(() => ({ send: mockSend })),
    DescribeInstancesCommand: jest.fn(),
    __mockSend: mockSend,
  };
});

// Mock the provisioner
jest.mock('../src/provisioner', () => ({
  destroyVM: jest.fn().mockResolvedValue({ status: 'terminated' }),
  getActiveSessions: jest.fn().mockReturnValue([]),
}));

const { __mockSend } = require('@aws-sdk/client-ec2');
const { destroyVM } = require('../src/provisioner');

describe('Lifecycle Manager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('checkSession', () => {
    test('destroys VM when TTL has expired', async () => {
      const session = {
        sessionId: 'sess-expired',
        instanceId: 'i-1234567890',
        ttlExpiry: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
        status: 'active',
      };

      await checkSession(session);

      expect(destroyVM).toHaveBeenCalledWith('sess-expired');
    });

    test('does not destroy VM when TTL has not expired', async () => {
      __mockSend.mockResolvedValue({
        Reservations: [{
          Instances: [{
            State: { Name: 'running' },
            InstanceId: 'i-1234567890',
          }],
        }],
      });

      const session = {
        sessionId: 'sess-active',
        instanceId: 'i-1234567890',
        ttlExpiry: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
        status: 'active',
      };

      await checkSession(session);

      expect(destroyVM).not.toHaveBeenCalled();
    });

    test('sets warning flag when close to TTL expiry', async () => {
      __mockSend.mockResolvedValue({
        Reservations: [{
          Instances: [{
            State: { Name: 'running' },
            InstanceId: 'i-1234567890',
          }],
        }],
      });

      const session = {
        sessionId: 'sess-warning',
        instanceId: 'i-1234567890',
        ttlExpiry: new Date(Date.now() + 2 * 60 * 1000).toISOString(), // 2 minutes from now
        status: 'active',
      };

      await checkSession(session);

      expect(session._warningSent).toBe(true);
    });

    test('marks session terminated when instance not found', async () => {
      __mockSend.mockResolvedValue({
        Reservations: [],
      });

      const session = {
        sessionId: 'sess-gone',
        instanceId: 'i-9999999999',
        ttlExpiry: new Date(Date.now() + 3600000).toISOString(),
        status: 'active',
      };

      await checkSession(session);

      expect(session.status).toBe('terminated');
    });

    test('destroys stopped instances', async () => {
      __mockSend.mockResolvedValue({
        Reservations: [{
          Instances: [{
            State: { Name: 'stopped' },
            InstanceId: 'i-stopped',
          }],
        }],
      });

      const session = {
        sessionId: 'sess-stopped',
        instanceId: 'i-stopped',
        ttlExpiry: new Date(Date.now() + 3600000).toISOString(),
        status: 'active',
      };

      await checkSession(session);

      expect(destroyVM).toHaveBeenCalledWith('sess-stopped');
    });
  });
});
