import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Exercises the guest-side shell assets without needing root, IMDS, or a VM.
 *
 * `dfap-provision.sh --self-test` runs the SAME payload-validation rules the
 * control plane implements and asserts a valid fixture passes while tampered /
 * expired / mis-bound ones are rejected. `bash -n` syntax-checks both scripts.
 *
 * These are LOCAL fixtures: passing them pins the contract and the fail-closed
 * logic; it is NOT proof of real VM isolation (that needs a live instance whose
 * AWS-signed identity document is verified against AWS's regional certs).
 */

const PROVISION = fileURLToPath(new URL('../../../infra/packer/provision/guest/dfap-provision.sh', import.meta.url));
const DEPROVISION = fileURLToPath(new URL('../../../infra/packer/provision/guest/dfap-deprovision.sh', import.meta.url));

function which(bin: string): boolean {
  try {
    execFileSync('bash', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const haveBash = which('bash');
const haveJq = which('jq');

describe('guest provisioning shell assets', () => {
  it.skipIf(!haveBash)('provision + deprovision scripts are syntactically valid bash', () => {
    expect(() => execFileSync('bash', ['-n', PROVISION])).not.toThrow();
    expect(() => execFileSync('bash', ['-n', DEPROVISION])).not.toThrow();
  });

  it.skipIf(!haveBash || !haveJq)('provision script self-test: valid package accepted, tampered/expired/mis-bound rejected', () => {
    // The script logs via `logger` (which on macOS writes to syslog), so we
    // assert on the exit status: a non-zero exit means at least one fixture
    // assertion inside the script failed.
    expect(() => execFileSync('bash', [PROVISION, '--self-test'], { stdio: 'ignore' })).not.toThrow();
  });

  it('refuses to provision when disabled (fail-closed)', () => {
    // With DFAP_PROVISIONING_ENABLED unset, the default provisioning run must
    // refuse rather than expose a login.
    let failed = false;
    try {
      execFileSync('bash', [PROVISION], { stdio: 'ignore', env: { ...process.env, DFAP_PROVISIONING_ENABLED: '0' } });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
