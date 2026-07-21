# DisFAP Security Model

This document is the canonical statement of what DisFAP guarantees, what it does not, and where each guarantee is enforced in code. It is written to double as the basis for customer security questionnaires.

## Threat model

**Assets:** customer application data visible inside a session; session credentials; session recordings; the platform's own secrets.

**Adversaries considered:**

| Adversary | Capability assumed |
|---|---|
| Malicious/compromised session user | Full control of their browser and device; valid login |
| Compromised client device | Malware with access to everything the browser holds |
| Network attacker | Observe/replay/modify traffic between browser and platform |
| Compromised session VM | Arbitrary code execution inside the guest |
| Curious/negligent insider at a tenant org | Valid admin credentials for their own org only |

**Explicitly out of scope:** shoulder-surfing and camera capture of the screen (mitigated by watermarking, not prevented); a compromised control plane (that is game over for any platform — mitigated by minimizing its secret surface, not by design guarantees).

## Guarantee 1 — Pixel-only: no data channel to the client

The client receives rendered pixels and sends keyboard/mouse input. Nothing else. Enforced in **four independent layers**, so no single misconfiguration or compromise opens a channel:

| # | Layer | Enforcement point | Survives |
|---|---|---|---|
| 1 | guacd connection parameters | `disable-copy`, `disable-paste`, `enable-drive=false`, `enable-printing=false`, no SFTP — set server-side by the broker, never client-influenced | Client tampering |
| 2 | **Broker instruction filter** | [services/broker/src/instruction-filter.ts](../services/broker/src/instruction-filter.ts) — client→guacd strict allowlist (`mouse`, `key`, `size`, `sync`, `nop`, `disconnect`); guacd→client stream-index tracking that drops `file`/`clipboard`/`pipe` streams while passing `img`/`audio` | Layer-1 misconfiguration; guacd parameter regressions |
| 3 | Guest OS policy | xrdp channel config / Windows GPO baked into the hardened image — redirection disabled at the host | A compromised **broker** trying to enable channels |
| 4 | Browser client | `onfile`/`onclipboard` handlers never attached; no clipboard bridge instantiated | Accidental client-code regressions |

Layer 2 is the load-bearing one and the only one we fully control at runtime. Any non-allowlisted instruction is dropped **and logged as a security event** against the session; repeated violations flag the session for termination.

## Guarantee 2 — Credentials never transit the client

The browser receives a 60-second, single-use, HMAC-SHA256-signed **handle** naming a session id — nothing else (see [adr/002](adr/002-opaque-token-over-guacamole-auth-json.md)). The broker resolves the handle server-side and fetches the VM credential from Vault with a response-wrapped, read-once token. Replayed handles terminate the session. Verification: a devtools network capture of a full session contains no hostname, username, or password in any payload.

## Guarantee 3 — Session isolation

- One security group per session; ingress only from guacd's SG on the RDP port; **no self-referencing rules** — tenant VMs can never reach each other.
- Egress default-deny with per-org allowlist. For third-party-access use cases, egress *is* the exfiltration path; blocking it is a feature.
- No public IPs on session VMs. Admin access via SSM only; no bastion, no SSH keys on disk.
- Continuously verified: a nightly job launches sessions in two orgs and asserts zero cross-reachability from inside each VM.

## Guarantee 4 — Ephemerality

VMs boot from an offline-hardened golden image whose AMI id and snapshot SHA-256 are recorded per session, and are **destroyed, never reused** ([adr/004](adr/004-burn-after-reading-vms.md)). Five independent teardown layers ensure destruction happens even under total control-plane failure.

## Guarantee 5 — Tamper-evident audit

Session recordings are written on trusted infrastructure (the guacd node, not the VM), streamed to S3 with Object Lock (WORM), and chunk-chained with Vault Transit HMACs so removal or alteration of any frame is detectable. The platform audit log is hash-chained the same way. Recording access is itself an audited, privileged action.

## Known limitations (stated, not hidden)

- Pixels on a screen can be photographed. Watermarking (per-session, per-user overlay) makes leaks attributable, not impossible.
- Vault is a hard dependency for *new* sessions. Existing sessions survive a Vault outage; creation fails fast with a clear error.
- The shared-guacd tier means one hardened process handles multiple tenants' pixel streams. The premium tier moves guacd to a per-VM sidecar.
