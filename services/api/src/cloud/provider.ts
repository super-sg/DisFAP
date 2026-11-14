/**
 * CloudProvider — the seam between the pool manager/reaper and whatever
 * actually runs VMs. The rest of the control plane never imports an AWS SDK
 * type; it speaks this interface only.
 *
 * Two implementations ship here:
 *  - `FakeCloudProvider`: in-memory, deterministic, no network. Used by tests
 *    and by Phase-0 local development.
 *  - `AwsCloudProvider`: **real** EC2 through `@aws-sdk/client-ec2` —
 *    `RunInstances` (tag-on-create, idempotency token, delete-on-terminate
 *    root volume), `DescribeInstances` (single-instance readiness probe and
 *    tag-filtered fleet view) and `TerminateInstances` — launched from a
 *    launch template (ADR-001). The SDK is reached with a dynamic `import()`
 *    so this module imports with no AWS SDK and no credentials; both are only
 *    touched on the first call. Tests supply `ec2ClientFactory` instead of the
 *    SDK, so the request/response handling is covered without any AWS call.
 */

/** The intent to create one burn-after-reading session VM. */
export interface LaunchSpec {
  /** Workspace template this instance serves (drives launch-template choice). */
  templateId: string;
  region: string;
  /** Optional AZ pin; the cloud picks one if omitted. */
  az?: string;
  /** Hardened image to boot (AMI id). */
  imageId: string;
  instanceType: string;
  /** Session this VM is being claimed for, if known at launch (cold path). */
  sessionId?: string;
  orgId: string;
  /** Hard teardown deadline; also stamped as the `dfap:expires_at` tag. */
  expiresAt: Date;
  /** Per-session security group, if pre-created. */
  securityGroupId?: string;
  /**
   * Pre-boot credential blob written onto the VM's disk before first boot
   * (see cloud/disk-injector.ts — the spec's offline injection step).
   * Never carries plaintext credentials.
   */
  userData?: string;
}

export interface LaunchedInstance {
  cloudInstanceId: string;
  privateIp?: string;
  /**
   * Public (elastic) IP when the instance has one. The control plane runs
   * OUTSIDE the VPC in the local evaluation topology, so the broker/guacd must
   * reach the instance on this address; when present the pool records it as the
   * connect host (see pool/pool-manager.ts). `undefined` when the instance has
   * no public IP (normal in-VPC production deployments).
   */
  publicIp?: string;
  az: string;
  launchedAt: Date;
}

export type ManagedInstanceState = 'pending' | 'running' | 'stopping' | 'stopped' | 'shutting-down' | 'terminated';

/** Ground truth as reported by the cloud, used by the reaper to reconcile. */
export interface ManagedInstance {
  cloudInstanceId: string;
  state: ManagedInstanceState;
  privateIp?: string;
  publicIp?: string;
  launchedAt: Date;
  /** Resource tags; `dfap:*` tags identify DisFAP-managed instances. */
  tags: Record<string, string>;
  /** Pre-boot blob the instance booted with, if any (audit view). */
  userData?: string;
}

/**
 * Point-in-time view of one instance, used by the readiness reconciler to
 * confirm a VM is genuinely up (and reachable) before a session is reported
 * `ready` (no fabricated readiness).
 */
export interface CloudInstanceInfo {
  state: ManagedInstanceState;
  privateIp?: string;
  publicIp?: string;
}

export interface CloudProvider {
  launchInstance(spec: LaunchSpec): Promise<LaunchedInstance>;
  terminateInstance(cloudInstanceId: string): Promise<void>;
  /** Every instance the cloud currently reports as DisFAP-managed. */
  describeManaged(): Promise<ManagedInstance[]>;
  /**
   * Describe one instance by cloud id, or null if the cloud no longer knows it.
   * Optional so pure test fakes stay small; when absent the readiness
   * reconciler treats readiness as unverifiable and never flips a session to
   * `ready` on its own.
   */
  describeInstance?(cloudInstanceId: string): Promise<CloudInstanceInfo | null>;
}

/** Build the canonical `dfap:*` tag set applied on-create to every instance. */
export function dfapTags(spec: LaunchSpec): Record<string, string> {
  return {
    'dfap:managed': 'true',
    'dfap:org_id': spec.orgId,
    'dfap:template_id': spec.templateId,
    'dfap:expires_at': spec.expiresAt.toISOString(),
    ...(spec.sessionId !== undefined ? { 'dfap:session_id': spec.sessionId } : {}),
  };
}

/**
 * EC2 answers a request for an instance it no longer knows with
 * `InvalidInstanceID.NotFound`; the AWS SDK v3 surfaces it as `err.name`. Both
 * `describeInstance` and `terminateInstance` treat that as "gone", not as an
 * error — read paths return `null`, teardown paths succeed.
 */
function isInstanceNotFound(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'InvalidInstanceID.NotFound';
}

// ---------------------------------------------------------------------------
// FakeCloudProvider
// ---------------------------------------------------------------------------

/**
 * In-memory cloud. Deterministic ids (`i-fake-<n>`), instant "launches".
 * Tests can also inject un-tracked instances via `injectUnmanagedDrift()` to
 * exercise the reaper's orphan path.
 */
export class FakeCloudProvider implements CloudProvider {
  private seq = 0;
  private readonly instances = new Map<string, ManagedInstance>();

  async launchInstance(spec: LaunchSpec): Promise<LaunchedInstance> {
    const id = `i-fake-${++this.seq}`;
    const az = spec.az ?? `${spec.region}a`;
    const launchedAt = new Date();
    const ip = `10.0.0.${this.seq % 250}`;
    this.instances.set(id, {
      cloudInstanceId: id,
      state: 'running',
      privateIp: ip,
      launchedAt,
      tags: dfapTags(spec),
      // Audit view: the blob that sat on the disk before this instance booted.
      ...(spec.userData !== undefined ? { userData: spec.userData } : {}),
    });
    return { cloudInstanceId: id, privateIp: ip, az, launchedAt };
  }

  async terminateInstance(cloudInstanceId: string): Promise<void> {
    const inst = this.instances.get(cloudInstanceId);
    // Idempotent: terminating an unknown/already-gone instance is a no-op.
    if (inst) inst.state = 'terminated';
  }

  async describeInstance(cloudInstanceId: string): Promise<CloudInstanceInfo | null> {
    const inst = this.instances.get(cloudInstanceId);
    if (!inst) return null;
    return {
      state: inst.state,
      ...(inst.privateIp !== undefined ? { privateIp: inst.privateIp } : {}),
      ...(inst.publicIp !== undefined ? { publicIp: inst.publicIp } : {}),
    };
  }

  async describeManaged(): Promise<ManagedInstance[]> {
    // Mirror EC2: terminated instances stop being reported after a while.
    return [...this.instances.values()].filter((i) => i.state !== 'terminated');
  }

  /** Test helper: register a DisFAP-tagged instance the control plane never recorded. */
  injectUnmanagedDrift(inst: {
    cloudInstanceId: string;
    launchedAt: Date;
    tags?: Record<string, string>;
  }): void {
    this.instances.set(inst.cloudInstanceId, {
      cloudInstanceId: inst.cloudInstanceId,
      state: 'running',
      launchedAt: inst.launchedAt,
      tags: inst.tags ?? { 'dfap:managed': 'true' },
    });
  }

  /** Test helper. */
  isTerminated(cloudInstanceId: string): boolean {
    return this.instances.get(cloudInstanceId)?.state === 'terminated';
  }
}

// ---------------------------------------------------------------------------
// AwsCloudProvider (real EC2; SDK reached lazily)
// ---------------------------------------------------------------------------

/**
 * The slice of `@aws-sdk/client-ec2` this provider uses. Declared structurally
 * so a test double satisfies it without the SDK installed, and so no AWS SDK
 * type leaks into the rest of the control plane.
 */
export interface Ec2ClientLike {
  send: (cmd: unknown) => Promise<unknown>;
  RunInstancesCommand: new (input: unknown) => unknown;
  TerminateInstancesCommand: new (input: unknown) => unknown;
  DescribeInstancesCommand: new (input: unknown) => unknown;
}

export interface AwsCloudProviderOptions {
  region: string;
  /** Launch template that *is* the VM spec (Terraform-owned, version-pinned). */
  launchTemplateId: string;
  launchTemplateVersion?: string;
  /**
   * Root EBS volume size in GiB. Sent on `RunInstances` because the request's
   * block-device mapping overrides the launch template's for the same device.
   * Defaults to 20 GiB when omitted.
   */
  sessionVolumeGiB?: number;
  /**
   * Test seam. When omitted the real SDK is loaded on first use via
   * `loadAwsEc2Client()`. Injected by tests so the request/response handling —
   * including AWS errors — is covered with no AWS call and no credentials.
   */
  ec2ClientFactory?: () => Promise<Ec2ClientLike>;
}

/** Build the EC2 request without mixing launch-template ENI and top-level SG settings. */
export function buildRunInstancesInput(
  opts: AwsCloudProviderOptions,
  spec: LaunchSpec,
): Record<string, unknown> {
  const tags = dfapTags(spec);
  const tagList = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

  if (spec.securityGroupId !== undefined) {
    throw new Error(
      'securityGroupId overrides are not supported when the launch template owns the network interface; ' +
        'configure the required session security group in the launch template',
    );
  }

  return {
    LaunchTemplate: {
      LaunchTemplateId: opts.launchTemplateId,
      ...(opts.launchTemplateVersion ? { Version: opts.launchTemplateVersion } : {}),
    },
    MinCount: 1,
    MaxCount: 1,
    // Idempotency. The SDK retries transient `RunInstances` failures, and a
    // retried launch with no token would create a SECOND billable instance.
    // Deriving the token from the session makes every retry of one claim map
    // to at most one instance. Omitted when the caller has no session yet.
    ...(spec.sessionId ? { ClientToken: `dfap-${spec.sessionId}` } : {}),
    ...(spec.az ? { Placement: { AvailabilityZone: spec.az } } : {}),
    // The launch template owns the ENI, subnet, private-IP posture and base SG.
    // Do not send top-level SecurityGroupIds: EC2 rejects that combination.
    TagSpecifications: [
      { ResourceType: 'instance', Tags: tagList },
      { ResourceType: 'volume', Tags: tagList },
    ],
    // The request's block-device mapping overrides the launch template's for the
    // same device name, so the root volume size is sent explicitly here. Because
    // the override REPLACES the template's mapping, `Encrypted: true` must be
    // explicit too — otherwise a template that encrypted the volume would be
    // silently downgraded to the account default (or to unencrypted). The
    // volume is reclaimed on terminate, so deletion + encryption at rest are the
    // erasure mechanism (no overwrite pass is claimed).
    BlockDeviceMappings: [
      {
        DeviceName: '/dev/sda1',
        Ebs: {
          DeleteOnTermination: true,
          Encrypted: true,
          VolumeSize: opts.sessionVolumeGiB ?? 20,
          VolumeType: 'gp3',
        },
      },
    ],
    ...(spec.userData !== undefined ? { UserData: Buffer.from(spec.userData, 'utf8').toString('base64') } : {}),
  };
}

/**
 * Load the EC2 client from `@aws-sdk/client-ec2`. The specifier is held in a
 * variable so the compiler never resolves it statically: the package is a real
 * dependency of this service, but keeping the import dynamic means this module
 * (and every fake-only test) loads with no SDK and no credentials.
 *
 * One `EC2Client` is cached per provider instance. Building one per call would
 * re-resolve credentials (an SSO/IMDS round trip) and open a new connection
 * pool on every describe/terminate.
 */
export async function loadAwsEc2Client(region: string): Promise<Ec2ClientLike> {
  const sdkModule = '@aws-sdk/client-ec2';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk: any = await import(sdkModule);
  const client = new sdk.EC2Client({ region });
  return {
    send: (cmd) => client.send(cmd),
    RunInstancesCommand: sdk.RunInstancesCommand,
    TerminateInstancesCommand: sdk.TerminateInstancesCommand,
    DescribeInstancesCommand: sdk.DescribeInstancesCommand,
  };
}

/**
 * Real EC2. The launch template supplies AMI, instance type, subnet, IAM
 * profile and base security groups (ADR-001), so this provider adds only what
 * is per-session: tag-on-create, an idempotency token, and an explicit root
 * volume with `DeleteOnTermination` so terminating reclaims the storage.
 *
 * Nothing here asserts readiness. `describeInstance` reports exactly what EC2
 * says and `pool/readiness.ts` is the only component allowed to promote a
 * session — so a `running` report from EC2 still has to pass a TCP probe.
 */
export class AwsCloudProvider implements CloudProvider {
  private client: Promise<Ec2ClientLike> | undefined;

  constructor(private readonly opts: AwsCloudProviderOptions) {}

  /** The shared EC2 client: the injected fake in tests, else the real SDK. */
  private ec2(): Promise<Ec2ClientLike> {
    this.client ??= this.opts.ec2ClientFactory
      ? this.opts.ec2ClientFactory()
      : loadAwsEc2Client(this.opts.region);
    return this.client;
  }

  async launchInstance(spec: LaunchSpec): Promise<LaunchedInstance> {
    const { send, RunInstancesCommand } = await this.ec2();
    const input = buildRunInstancesInput(this.opts, spec);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = await send(new RunInstancesCommand(input));
    const inst = out?.Instances?.[0];
    if (!inst?.InstanceId) throw new Error('RunInstances returned no instance id');
    return {
      cloudInstanceId: inst.InstanceId,
      ...(inst.PrivateIpAddress ? { privateIp: inst.PrivateIpAddress } : {}),
      ...(inst.PublicIpAddress ? { publicIp: inst.PublicIpAddress } : {}),
      az: inst.Placement?.AvailabilityZone ?? spec.az ?? `${spec.region}a`,
      launchedAt: inst.LaunchTime ? new Date(inst.LaunchTime) : new Date(),
    };
  }

  async describeInstance(cloudInstanceId: string): Promise<CloudInstanceInfo | null> {
    const { send, DescribeInstancesCommand } = await this.ec2();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let out: any;
    try {
      out = await send(new DescribeInstancesCommand({ InstanceIds: [cloudInstanceId] }));
    } catch (err) {
      // EC2 purges a terminated instance after about an hour. The interface
      // promises `null` when "the cloud no longer knows it", and the readiness
      // reconciler depends on that: a throw from here aborts the whole pass and
      // stalls every other pending session.
      if (isInstanceNotFound(err)) return null;
      throw err;
    }
    const inst = out?.Reservations?.[0]?.Instances?.[0];
    if (!inst) return null;
    return {
      state: (inst?.State?.Name ?? 'running') as ManagedInstanceState,
      ...(inst.PrivateIpAddress ? { privateIp: inst.PrivateIpAddress } : {}),
      ...(inst.PublicIpAddress ? { publicIp: inst.PublicIpAddress } : {}),
    };
  }

  async terminateInstance(cloudInstanceId: string): Promise<void> {
    const { send, TerminateInstancesCommand } = await this.ec2();
    try {
      await send(new TerminateInstancesCommand({ InstanceIds: [cloudInstanceId] }));
    } catch (err) {
      // Idempotent teardown — the same contract `FakeCloudProvider` advertises.
      // Terminating an instance EC2 has already purged is success, not a
      // failure the reaper should retry (and re-log) forever.
      if (!isInstanceNotFound(err)) throw err;
    }
  }

  async describeManaged(): Promise<ManagedInstance[]> {
    const { send, DescribeInstancesCommand } = await this.ec2();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = await send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: 'tag:dfap:managed', Values: ['true'] },
          // A terminated instance is no longer *managed*: EC2 keeps it visible
          // for roughly an hour after termination, and returning it would make
          // the reaper re-issue TerminateInstances for it — and report it as
          // freshly terminated — on every pass. Exclude one already shutting
          // down for the same reason.
          { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] },
        ],
      }),
    );
    const result: ManagedInstance[] = [];
    for (const res of out?.Reservations ?? []) {
      for (const inst of res?.Instances ?? []) {
        const tags: Record<string, string> = {};
        for (const t of inst?.Tags ?? []) if (t?.Key) tags[t.Key] = t.Value ?? '';
        result.push({
          cloudInstanceId: inst.InstanceId,
          state: (inst?.State?.Name ?? 'running') as ManagedInstanceState,
          ...(inst.PrivateIpAddress ? { privateIp: inst.PrivateIpAddress } : {}),
          ...(inst.PublicIpAddress ? { publicIp: inst.PublicIpAddress } : {}),
          launchedAt: inst.LaunchTime ? new Date(inst.LaunchTime) : new Date(),
          tags,
        });
      }
    }
    return result;
  }
}
