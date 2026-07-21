# DisFAP — Distributed Federated Access Platform

**Secure workspace-as-a-service.** Contractors, offshore teams, auditors, and other third parties work on sensitive apps and data through the browser — and the endpoint never holds anything but pixels.

## The guarantee

The client receives a rendered pixel stream over an HTML5 canvas. There is no file transfer, no clipboard, no drive redirection, no data channel of any kind — and that absence is *enforced in four independent layers*, not configured in one place. See [docs/security.md](docs/security.md).

## How a session works

```
User clicks "Start session"
  │
  ▼
Control plane (services/api)
  ├─ claims a pre-hardened ephemeral VM (warm pool; never reused across sessions)
  ├─ asks Vault to mint a short-lived credential for that VM
  └─ hands the browser a 60-second, single-use, HMAC-SHA256-signed handle
  │
  ▼
Broker (services/broker)
  ├─ redeems the handle (replay ⇒ session terminated)
  ├─ pulls the VM credential from Vault server-side — it never reaches the client
  ├─ connects through guacd (RDP) to the session VM
  └─ streams pixels over WebSocket, filtering the Guacamole instruction stream
  │
  ▼
Browser renders canvas (guacamole-common-js). Session ends ⇒ VM is destroyed.
```

## Repository layout

| Path | What |
|---|---|
| [services/api/](services/api/) | Control plane: sessions, pool manager, reaper, billing |
| [services/broker/](services/broker/) | Session gateway: token redemption, instruction filter, guacd tunnel |
| [apps/web/](apps/web/) | Browser client (React + guacamole-common-js) |
| [infra/terraform/](infra/terraform/) | Fleet infrastructure — VPC, security groups, launch templates. **Not run per session.** |
| [infra/packer/](infra/packer/) | Hardened golden-image pipeline (Packer + offline hardening stage) |
| [docs/](docs/) | Architecture, security model, ADRs, runbooks |

## Development

```sh
npm install
npm test          # all workspaces
npm run typecheck
```

Node ≥ 22 required. The broker's instruction-filter tests run with no AWS dependency — start there.

## Documentation

- [docs/architecture.md](docs/architecture.md) — full component design and session lifecycle
- [docs/security.md](docs/security.md) — threat model and the four isolation layers
- [docs/adr/](docs/adr/) — why the load-bearing decisions were made
