# ADR-004: Burn-after-reading VMs

**Status:** accepted · 2026-07-22

## Decision

**A session VM is never reused across sessions.** On session end — for any reason — the instance is terminated, its per-session security group deleted, and its credential revoked in Vault. There is no sanitize-and-return-to-pool path.

## Rationale

1. **Security story:** no residue of one session can reach the next. There is no sanitization procedure to design, verify, or get wrong — termination is the sanitization.
2. **Credential model:** the Windows/Linux session credential is minted at claim time and its lifetime ≈ session lifetime. The blast radius of a leaked credential is one already-destroyed machine.
3. **Auditability:** every session row references the exact hardened image (AMI + snapshot SHA-256) it booted. "What could this session access?" has a static answer.

## Consequences

- Pool churn is a permanent COGS line: 1-minute EC2 billing minimum + 60–90 s unbillable warm-up per session. Priced into unit economics.
- Teardown reliability becomes existential — five independent layers (normal path, tag-on-create, guest dead-man switch, 60 s reaper, account-level guardrails) are specified in [../architecture.md](../architecture.md).
- Warm-pool sizing must account for one-way flow: claimed instances exit the pool permanently.
