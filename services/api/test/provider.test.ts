import { describe, expect, it, vi } from 'vitest';

import {
  AwsCloudProvider,
  buildRunInstancesInput,
  type Ec2ClientLike,
  type LaunchSpec,
} from '../src/cloud/provider.js';

const spec: LaunchSpec = {
  templateId: 'tmpl_linux_dev',
  region: 'ap-south-1',
  imageId: 'ami-0123456789abcdef0',
  instanceType: 't4g.small',
  sessionId: 'ses_demo',
  orgId: 'org_demo',
  expiresAt: new Date('2026-10-17T03:00:00Z'),
};

const providerOpts = { region: 'ap-south-1', launchTemplateId: 'lt-0123456789abcdef0' };

describe('buildRunInstancesInput', () => {
  it('leaves ENI and security-group ownership to the launch template', () => {
    const input = buildRunInstancesInput(
      { region: 'ap-south-1', launchTemplateId: 'lt-0123456789abcdef0' },
      spec,
    );

    expect(input).not.toHaveProperty('SecurityGroupIds');
    expect(input).not.toHaveProperty('NetworkInterfaces');
    expect(input.LaunchTemplate).toEqual({ LaunchTemplateId: 'lt-0123456789abcdef0' });
  });

  it('fails instead of sending a conflicting security-group override', () => {
    expect(() =>
      buildRunInstancesInput(
        { region: 'ap-south-1', launchTemplateId: 'lt-0123456789abcdef0' },
        { ...spec, securityGroupId: 'sg-0123456789abcdef0' },
      ),
    ).toThrow(/launch template owns the network interface/);
  });

  it('sends an explicit root-volume size that is reclaimed on terminate', () => {
    const input = buildRunInstancesInput(
      { region: 'ap-south-1', launchTemplateId: 'lt-0123456789abcdef0', sessionVolumeGiB: 24 },
      spec,
    );
    expect(input.BlockDeviceMappings).toEqual([
      { DeviceName: '/dev/sda1', Ebs: { DeleteOnTermination: true, Encrypted: true, VolumeSize: 24, VolumeType: 'gp3' } },
    ]);
  });

  it('defaults the root-volume size when no option is supplied', () => {
    const input = buildRunInstancesInput(
      { region: 'ap-south-1', launchTemplateId: 'lt-0123456789abcdef0' },
      spec,
    );
    expect(input.BlockDeviceMappings).toEqual([
      { DeviceName: '/dev/sda1', Ebs: { DeleteOnTermination: true, Encrypted: true, VolumeSize: 20, VolumeType: 'gp3' } },
    ]);
  });

  it('sends a session-derived idempotency token so a retried launch cannot double-bill', () => {
    // The SDK retries transient RunInstances failures. With no token each retry
    // creates another instance; the token makes them collapse to one.
    const input = buildRunInstancesInput(
      { region: 'ap-south-1', launchTemplateId: 'lt-0123456789abcdef0' },
      spec,
    );
    expect(input.ClientToken).toBe('dfap-ses_demo');
  });

  it('omits the idempotency token when there is no session yet', () => {
    const { sessionId: _omit, ...anonymous } = spec;
    const input = buildRunInstancesInput(
      { region: 'ap-south-1', launchTemplateId: 'lt-0123456789abcdef0' },
      anonymous,
    );
    expect(input).not.toHaveProperty('ClientToken');
  });
});

// ---------------------------------------------------------------------------
// AwsCloudProvider — real request/response handling, no AWS call
// ---------------------------------------------------------------------------

/**
 * Minimal EC2 double. Every command carries its request under `input` (as the
 * real SDK commands do); `sent` records each request so the test can assert on
 * what would have gone to EC2.
 */
function ec2Double(handler: (input: unknown, index: number) => Promise<unknown>): {
  client: Ec2ClientLike;
  sent: unknown[];
} {
  const sent: unknown[] = [];
  class Cmd {
    constructor(public readonly input: unknown) {}
  }
  const command = Cmd as unknown as Ec2ClientLike['RunInstancesCommand'];
  return {
    sent,
    client: {
      send: async (cmd) => {
        const input = (cmd as { input: unknown }).input;
        sent.push(input);
        return handler(input, sent.length - 1);
      },
      RunInstancesCommand: command,
      TerminateInstancesCommand: command,
      DescribeInstancesCommand: command,
    },
  };
}

/** A provider wired to the double, so nothing here touches the AWS SDK. */
function providerWith(handler: (input: unknown, index: number) => Promise<unknown>): {
  provider: AwsCloudProvider;
  sent: unknown[];
} {
  const { client, sent } = ec2Double(handler);
  return {
    provider: new AwsCloudProvider({ ...providerOpts, ec2ClientFactory: async () => client }),
    sent,
  };
}

/** Shape of the SDK's `err.name`, which is all the provider inspects. */
function awsError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

describe('AwsCloudProvider.launchInstance', () => {
  it('maps a RunInstances response onto the launched instance', async () => {
    const { provider, sent } = providerWith(async () => ({
      Instances: [
        {
          InstanceId: 'i-0abc123',
          PrivateIpAddress: '172.31.10.9',
          PublicIpAddress: '15.1.2.3',
          Placement: { AvailabilityZone: 'ap-south-1b' },
          LaunchTime: new Date('2026-10-19T05:00:00Z'),
        },
      ],
    }));

    const launched = await provider.launchInstance(spec);

    expect(launched).toEqual({
      cloudInstanceId: 'i-0abc123',
      privateIp: '172.31.10.9',
      publicIp: '15.1.2.3',
      az: 'ap-south-1b',
      launchedAt: new Date('2026-10-19T05:00:00Z'),
    });
    const input = sent[0] as Record<string, unknown>;
    expect(input['MinCount']).toBe(1);
    expect(input['MaxCount']).toBe(1);
    expect(JSON.stringify(input['TagSpecifications'])).toContain('dfap:managed');
  });

  it('omits the addresses when EC2 has not assigned them yet', async () => {
    // This is the real "pending" shape, and it is why the pool row can end up
    // holding the private IP: the readiness reconciler writes the reachable
    // host back once the instance is genuinely up.
    const { provider } = providerWith(async () => ({
      Instances: [{ InstanceId: 'i-0pending', Placement: { AvailabilityZone: 'ap-south-1b' } }],
    }));

    const launched = await provider.launchInstance(spec);

    expect(launched).not.toHaveProperty('publicIp');
    expect(launched).not.toHaveProperty('privateIp');
    expect(launched.cloudInstanceId).toBe('i-0pending');
  });

  it('throws when RunInstances returns no instance id', async () => {
    const { provider } = providerWith(async () => ({ Instances: [] }));
    await expect(provider.launchInstance(spec)).rejects.toThrow(/no instance id/);
  });

  it('propagates an AWS error from RunInstances', async () => {
    const { provider } = providerWith(async () => {
      throw awsError('UnauthorizedOperation', 'not authorized to perform ec2:RunInstances');
    });
    await expect(provider.launchInstance(spec)).rejects.toThrow(/not authorized/);
  });
});

describe('AwsCloudProvider.terminateInstance', () => {
  it('requests a terminate for the given instance id', async () => {
    const { provider, sent } = providerWith(async () => ({}));
    await provider.terminateInstance('i-0abc123');
    expect(sent[0]).toEqual({ InstanceIds: ['i-0abc123'] });
  });

  it('treats an instance EC2 no longer knows as an idempotent success', async () => {
    // EC2 purges a terminated instance after ~1h; teardown must not fail (or
    // be retried forever by the reaper) because the record is gone.
    const { provider } = providerWith(async () => {
      throw awsError('InvalidInstanceID.NotFound', 'instance not found');
    });
    await expect(provider.terminateInstance('i-0gone')).resolves.toBeUndefined();
  });

  it('surfaces a genuine terminate failure', async () => {
    const { provider } = providerWith(async () => {
      throw awsError('Throttling', 'rate exceeded');
    });
    await expect(provider.terminateInstance('i-0abc123')).rejects.toThrow('rate exceeded');
  });
});

describe('AwsCloudProvider.describeInstance', () => {
  it('reports the state and addresses for the readiness probe', async () => {
    const { provider, sent } = providerWith(async () => ({
      Reservations: [{ Instances: [{ State: { Name: 'running' }, PublicIpAddress: '15.1.2.3' }] }],
    }));

    await expect(provider.describeInstance('i-0abc123')).resolves.toEqual({
      state: 'running',
      publicIp: '15.1.2.3',
    });
    expect(sent[0]).toEqual({ InstanceIds: ['i-0abc123'] });
  });

  it('returns null when EC2 no longer knows the instance', async () => {
    // The documented contract is "null if the cloud no longer knows it". A
    // throw here would abort the whole readiness pass for every other session.
    const { provider } = providerWith(async () => {
      throw awsError('InvalidInstanceID.NotFound', 'instance not found');
    });
    await expect(provider.describeInstance('i-0gone')).resolves.toBeNull();
  });

  it('returns null for an empty response', async () => {
    const { provider } = providerWith(async () => ({ Reservations: [] }));
    await expect(provider.describeInstance('i-0none')).resolves.toBeNull();
  });
});

describe('AwsCloudProvider.describeManaged', () => {
  it('maps instances and their dfap tags', async () => {
    const { provider, sent } = providerWith(async () => ({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-0abc123',
              State: { Name: 'running' },
              PublicIpAddress: '15.1.2.3',
              Tags: [
                { Key: 'dfap:managed', Value: 'true' },
                { Key: 'dfap:org_id', Value: 'org_demo' },
              ],
              LaunchTime: new Date('2026-10-19T05:00:00Z'),
            },
          ],
        },
      ],
    }));

    const managed = await provider.describeManaged();

    expect(managed).toHaveLength(1);
    expect(managed[0]!.cloudInstanceId).toBe('i-0abc123');
    expect(managed[0]!.tags['dfap:org_id']).toBe('org_demo');

    const input = sent[0] as { Filters: { Name: string; Values: string[] }[] };
    expect(input.Filters.some((f) => f.Name === 'tag:dfap:managed')).toBe(true);
    // EC2 keeps terminated/shutting-down instances visible for a while; asking
    // only for live states stops the reaper re-terminating and re-logging them.
    const states = input.Filters.find((f) => f.Name === 'instance-state-name')!.Values;
    expect(states).not.toContain('terminated');
    expect(states).not.toContain('shutting-down');
  });
});

describe('AwsCloudProvider client lifecycle', () => {
  it('builds the EC2 client once and reuses it', async () => {
    const factory = vi.fn(async () => ec2Double(async () => ({}))!.client);
    const provider = new AwsCloudProvider({ ...providerOpts, ec2ClientFactory: factory });

    await provider.terminateInstance('i-1');
    await provider.terminateInstance('i-2');

    // Re-resolving credentials (an SSO/IMDS round trip) per call is what we are
    // avoiding; one client per provider instance.
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
