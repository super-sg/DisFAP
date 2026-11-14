/**
 * Broker server factory: a WebSocket server that hands each connection to a
 * Tunnel. Also serves a plain `/healthz` for load-balancer checks.
 *
 * This file is deliberately thin — all behavior lives in Tunnel and its
 * injected dependencies, which are unit-tested without a socket. `createBroker`
 * receives the guacd adapter plus a session resolver and credential provider
 * supplied by the host process:
 *
 *  - in the supported topology the control plane hosts this in-process
 *    (`services/api/src/server.ts`) and injects its Prisma resolver + Vault
 *    provider;
 *  - a standalone launch is REFUSED (see the bottom of this file) because a
 *    broker with no resolver/identity answers /healthz and rejects every tunnel.
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { keyringFromConfig, readGuacdTls, type BrokerConfig } from './config.js';
import { GuacdAdapter } from './protocol/guacd-adapter.js';
import { Tunnel, type SecurityEvent, type TunnelDeps } from './tunnel.js';
import { wrapWebSocket } from './ws-adapter.js';
import { InMemoryNonceStore, type NonceStore } from './nonce-store.js';
import type { SessionResolver } from './session-resolver.js';
import type { CredentialProvider } from './vault/credential-provider.js';

export interface ServerDeps {
  resolver: SessionResolver;
  credentials: CredentialProvider;
  nonces?: NonceStore;
  onSecurityEvent?: (e: SecurityEvent) => void;
}

export function createBroker(cfg: BrokerConfig, deps: ServerDeps): { start: () => Promise<number>; stop: () => Promise<void> } {
  const http = createServer((rreq, rres) => {
    if (rreq.url === '/healthz') {
      rres.writeHead(200, { 'content-type': 'text/plain' });
      rres.end('ok');
      return;
    }
    rres.writeHead(404);
    rres.end();
  });

  const wss = new WebSocketServer({ server: http, path: cfg.path });
  const keyring = keyringFromConfig(cfg);
  const guacdTls = readGuacdTls(cfg);

  const tunnelDeps: TunnelDeps = {
    adapter: new GuacdAdapter({
      endpoint: {
        host: cfg.guacd.host,
        port: cfg.guacd.port,
        ...(guacdTls ? { tls: { ...guacdTls, servername: cfg.guacd.host } } : { tls: false }),
      },
    }),
    keyring,
    nonces: deps.nonces ?? new InMemoryNonceStore(),
    resolver: deps.resolver,
    credentials: deps.credentials,
    maxClientViolations: cfg.maxClientViolations,
    ...(deps.onSecurityEvent ? { onSecurityEvent: deps.onSecurityEvent } : {}),
  };

  wss.on('connection', (ws) => {
    new Tunnel(wrapWebSocket(ws), tunnelDeps);
  });

  return {
    start: () =>
      new Promise<number>((resolve) => {
        http.listen(cfg.port, () => {
          const addr = http.address();
          resolve(typeof addr === 'object' && addr ? addr.port : cfg.port);
        });
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        // Forcibly close live tunnels — a stop() that waits indefinitely for
        // clients to disconnect is a shutdown hang, not a graceful drain.
        for (const client of wss.clients) client.terminate();
        wss.close(() => http.close(() => resolve()));
      }),
  };
}

// Direct-run entrypoint (node dist/server.js).
if (import.meta.url === `file://${process.argv[1]}`) {
  // The broker is NOT self-sufficient: resolving a session id and fetching its
  // credential both require the control plane's database and Vault identity.
  // This entrypoint previously wired empty in-memory stubs, which produced a
  // process that answered /healthz with 200 while rejecting every tunnel with
  // 4003 — an outage disguised as a healthy service. Fail closed instead of
  // pretending to serve.
  // eslint-disable-next-line no-console
  console.error(
    '[broker] refusing to start standalone: no session resolver or credential provider is configured.\n' +
      '  Supported topology: the control plane hosts the broker in-process\n' +
      '  (services/api/src/server.ts — createBroker with PrismaSessionResolver +\n' +
      '  VaultCredentialProvider). A split deployment must first supply this\n' +
      '  process with an authenticated resolver and its own least-privilege Vault\n' +
      '  identity; see docs/security/architecture.md ("Broker trust boundary").',
  );
  process.exit(1);
}

