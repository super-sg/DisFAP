# ADR-002: Opaque capability token over guacamole-auth-json

**Status:** accepted · 2026-07-22

## Context

Guacamole's stock `guacamole-auth-json` extension implements almost exactly the flow DisFAP needs: a JSON payload, AES-encrypted, HMAC-SHA256-signed, POSTed by the browser to establish a session.

## Problem

That payload **contains the connection credentials** (hostname, username, password). It transits the client, anyone holding the shared secret can decrypt it, and it is replayable for its full validity window. For a product whose entire pitch is "the client device never holds anything," shipping the VM credential through the client — even encrypted — loses every security review.

## Decision

The token is an **opaque capability handle**, never a credential carrier:

```
DFAP1.<b64url(header)>.<b64url(payload)>.<b64url(HMAC-SHA256(K_kid, header.payload))>
payload = { sid, sub, org, aud:"broker", iat, exp:+60s, jti, cbh, scp:["connect"] }
```

- **60 s TTL, single use.** `jti` burned in Redis (`SET NX EX 120`) at redemption. A second redemption is treated as a compromise signal: reject **and terminate the session**.
- **No connection parameters, ever.** The broker resolves `sid` → session row → VM address, then pulls the credential from Vault server-side at connect time via a response-wrapped, read-once token.
- **Algorithm pinned** to HS256 in the verifier; `header.alg` is never trusted. Constant-time comparison.
- **Key rotation** via `kid`; keys live in Vault kv-v2, two valid for verification, one for signing.
- **Channel binding** (`cbh` = hash of client IP prefix + UA) is advisory-log-only initially — strict IP pinning generates mobile/NAT false positives.
- Token travels in the first WebSocket message — never in a query string that lands in access logs.

## Consequences

- Credentials cannot be exposed by a client-side compromise, XSS, or token theft — the token names a session, it doesn't unlock the VM.
- Requires our own broker rather than the stock Guacamole webapp (see ADR-003).
- Reconnects use a separate short-TTL rotating token type issued over the established WebSocket.
