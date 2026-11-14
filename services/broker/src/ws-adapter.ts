/** Adapts a `ws` WebSocket to the tunnel's ClientSocket interface. */

import type { WebSocket } from 'ws';
import type { ClientSocket } from './tunnel.js';

export function wrapWebSocket(ws: WebSocket): ClientSocket {
  return {
    onMessage(handler) {
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        // Guacamole protocol is UTF-8 text. Reject binary frames outright —
        // there is no legitimate binary path from the client.
        if (isBinary) {
          ws.close(4002, 'binary frames not permitted');
          return;
        }
        handler(data.toString('utf8'));
      });
    },
    onClose(handler) {
      ws.on('close', () => handler());
    },
    onError(handler) {
      ws.on('error', (err) => handler(err));
    },
    send(data) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
    close(code, reason) {
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
      }
    },
  };
}
