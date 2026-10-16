/**
 * CloudProvider — the seam between the pool manager/reaper and whatever
 * actually runs VMs. The rest of the control plane never imports an AWS SDK
 * type; it speaks this interface only.
 *
 * Two implementations ship here:
 *  - `FakeCloudProvider`: in-memory, deterministic, no network. Used by tests
 *    and by Phase-0 local development.
 *  - `AwsCloudProvider`: a thin, clearly-marked stub over EC2 `RunInstances`
 *    against a launch template (ADR-001). The SDK is loaded via dynamic
 *    `import()` so this module imports with no AWS SDK present and no creds.
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
// AwsCloudProvider (STUB — Phase-1)
// ---------------------------------------------------------------------------

export interface AwsCloudProviderOptions {
  region: string;
  /** Launch template that *is* the VM spec (Terraform-owned, version-pinned). */
  launchTemplateId: string;
  launchTemplateVersion?: string;
}

/**
 * STUB. Real EC2 wiring for Phase-1. The `@aws-sdk/client-ec2` dependency is
 * pulled in with a dynamic `import()` so importing this file never requires
 * the SDK to be installed and never touches the AWS credential chain — that
 * only happens on the first `launchInstance()`/`terminateInstance()` call.
 *
 * The launch template supplies AMI, instance type, subnet, IAM profile and
 * base security groups; we add only per-session tag-on-create and enforce
 * `DeleteOnTermination` on the root volume so a terminate reclaims storage.
 */
export class AwsCloudProvider implements CloudProvider {
  constructor(private readonly opts: AwsCloudProviderOptions) {}

  // Lazily construct the EC2 client. Typed loosely on purpose: we don't want a
  // hard type dependency on the SDK for callers that only use the fake.
  private async ec2(): Promise<{
    send: (cmd: unknown) => Promise<unknown>;
    RunInstancesCommand: new (input: unknown) => unknown;
    TerminateInstancesCommand: new (input: unknown) => unknown;
    DescribeInstancesCommand: new (input: unknown) => unknown;
  }> {
    // Specifier held in a variable so the compiler does not statically resolve
    // this optional dependency — it need not be installed to import this file.
    const sdkModule = '@aws-sdk/client-ec2';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk: any = await import(sdkModule);
    const client = new sdk.EC2Client({ region: this.opts.region });
    return {
      send: (cmd) => client.send(cmd),
      RunInstancesCommand: sdk.RunInstancesCommand,
      TerminateInstancesCommand: sdk.TerminateInstancesCommand,
      DescribeInstancesCommand: sdk.DescribeInstancesCommand,
    };
  }

  async launchInstance(spec: LaunchSpec): Promise<LaunchedInstance> {
    const { send, RunInstancesCommand } = await this.ec2();
    const tags = dfapTags(spec);
    const tagList = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

    const input = {
      LaunchTemplate: {
        LaunchTemplateId: this.opts.launchTemplateId,
        ...(this.opts.launchTemplateVersion ? { Version: this.opts.launchTemplateVersion } : {}),
      },
      MinCount: 1,
      MaxCount: 1,
      ...(spec.az ? { Placement: { AvailabilityZone: spec.az } } : {}),
      ...(spec.securityGroupId ? { SecurityGroupIds: [spec.securityGroupId] } : {}),
      // Tag on create so an instance is auditable and reap-able even if the
      // control plane crashes between RunInstances and the DB write.
      TagSpecifications: [
        { ResourceType: 'instance', Tags: tagList },
        { ResourceType: 'volume', Tags: tagList },
      ],
      // Root volume must die with the instance — no orphaned EBS billing.
      BlockDeviceMappings: [{ DeviceName: '/dev/sda1', Ebs: { DeleteOnTermination: true } }],
      // Pre-boot credential blob (sealed to the image's baked key, see
      // cloud/disk-injector.ts). EC2 requires base64.
      ...(spec.userData !== undefined ? { UserData: Buffer.from(spec.userData, 'utf8').toString('base64') } : {}),
    };

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
    const out: any = await send(new DescribeInstancesCommand({ InstanceIds: [cloudInstanceId] }));
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
    await send(new TerminateInstancesCommand({ InstanceIds: [cloudInstanceId] }));
  }

  async describeManaged(): Promise<ManagedInstance[]> {
    const { send, DescribeInstancesCommand } = await this.ec2();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = await send(
      new DescribeInstancesCommand({ Filters: [{ Name: 'tag:dfap:managed', Values: ['true'] }] }),
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
