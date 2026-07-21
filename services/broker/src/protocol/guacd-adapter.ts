/**
 * GuacdAdapter — implements ProtocolAdapter over the guacd handshake client.
 * GuacdClient.open already returns a ProtocolConnection, so this is a thin
 * naming/seam layer: the tunnel depends on ProtocolAdapter, never on guacd.
 */

import { GuacdClient, type GuacdClientOptions } from './guacd-client.js';
import type { ProtocolAdapter, ProtocolConnection, SessionCredential, SessionTarget } from './adapter.js';

export class GuacdAdapter implements ProtocolAdapter {
  readonly name = 'guacd';
  private readonly client: GuacdClient;

  constructor(opts: GuacdClientOptions) {
    this.client = new GuacdClient(opts);
  }

  connect(target: SessionTarget, credential: SessionCredential): Promise<ProtocolConnection> {
    return this.client.open(target, credential);
  }
}
