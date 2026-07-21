# ADR-003: guacd + Node broker over the Guacamole Java webapp

**Status:** accepted · 2026-07-22

## Context

Three integration paths with Apache Guacamole:

- **A.** Full `guacamole-client` (Java/Tomcat) with a custom `AuthenticationProvider` extension.
- **B.** Custom Node broker speaking the guacd protocol directly (via `guacamole-lite`), with `guacamole-common-js` in the browser.
- **C.** Sidecar guacd on each session VM.

## Decision

**B.** Keep **guacd** (15 years of RDP/VNC→Guacamole-protocol translation that must never be reimplemented) and **guacamole-common-js** (the canvas renderer). Skip the Java webapp entirely.

Because:
1. The webapp's auth model implies credentials-in-token (ADR-002 rejects this).
2. Running Tomcat alongside Node means two web apps, two auth models, two schemas — a permanent operational tax on a solo team.
3. **Instruction filtering is where the pixel-only guarantee lives.** In the Node tunnel it is ~80 auditable lines with tests; inside guacamole-client it means patching Java internals.

The broker is built against a `ProtocolAdapter` interface from day one. Guacamole is adapter #1; **NICE DCV** is planned as adapter #2 for GPU workloads, because the Guacamole wire protocol (tiled image updates, not video) cannot deliver acceptable framerates for motion-heavy work.

## Consequences

- We own the tunnel code: token redemption, filtering, reconnect, recording tee.
- Option C (sidecar guacd per VM) remains available later as a premium "no shared infrastructure" tier — the adapter seam makes it a deployment change, not a rewrite. It is not MVP because session recording must be written on trusted infrastructure, not the ephemeral VM.
- guacd runs in a private subnet, mTLS on 4822, reachable only from the broker's security group — guacd itself has no authentication.
