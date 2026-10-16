/**
 * Broker entrypoint: a WebSocket server that hands each connection to a
 * Tunnel. Also serves a plain `/healthz` for load-balancer checks.
 *
 * This file is deliberately thin — all behavior lives in Tunnel and its
 * injected dependencies, which are unit-tested without a socket. Here we only
 * wire real implementations (guacd adapter, Redis nonce store, HTTP session
 * resolver, Vault credential provider) to the tunnel.
 *
 * Phase-0 note: the session resolver and credential provider point at the
 * co-located control plane. Production swaps in the Vault-backed and
 * database-backed implementations without touching the tunnel.
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { keyringFromConfig, loadConfig, readGuacdTls, type BrokerConfig } from './config.js';
import { GuacdAdapter } from './protocol/guacd-adapter.js';
import { Tunnel, type SecurityEvent, type TunnelDeps } from './tunnel.js';
import { wrapWebSocket } from './ws-adapter.js';
import { InMemoryNonceStore, type NonceStore } from './nonce-store.js';
import { InMemorySessionResolver, type SessionResolver } from './session-resolver.js';
import { StaticCredentialProvider, type CredentialProvider } from './vault/credential-provider.js';

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
  const cfg = loadConfig();
  const resolver = new InMemorySessionResolver();
  const credentials = new StaticCredentialProvider();
  const broker = createBroker(cfg, { resolver, credentials });
  broker
    .start()
    .then((port) => {
      // eslint-disable-next-line no-console
      console.log(`[broker] DisFAP broker listening on port ${port} (standalone mode)`);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[broker] fatal: broker failed to start', err);
      process.exit(1);
    });

  const shutdown = async (): Promise<void> => {
    await broker.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

