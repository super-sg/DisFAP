/**
 * StripeClient — thin seam over Stripe so billing logic (webhook idempotency,
 * usage metering) is testable without the SDK or the network.
 *
 *  - `FakeStripeClient`: verifies against a shared secret, parses the payload.
 *  - `RealStripeClient`: STUB over the `stripe` SDK (dynamic import), using
 *    `webhooks.constructEvent` for real signature verification.
 */

export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export interface MeterEventInput {
  eventName: string; // e.g. "dfap_seat_seconds"
  stripeCustomerId: string;
  value: number;
  /** Idempotency key — our usage_records id — so retries don't double-bill. */
  identifier: string;
}

export class StripeSignatureError extends Error {
  readonly statusCode = 400;
  constructor(message = 'invalid stripe signature') {
    super(message);
    this.name = 'StripeSignatureError';
  }
}

export interface StripeClient {
  /** Verify + parse a webhook; throws `StripeSignatureError` on bad signature. */
  verifyWebhook(payload: string | Buffer, signature: string): StripeWebhookEvent;
  /** Report a metered-usage event (idempotent by `identifier`). */
  reportMeterEvent(input: MeterEventInput): Promise<{ id: string }>;
}

/** Test/Phase-0 client. "Signature" is just the shared webhook secret. */
export class FakeStripeClient implements StripeClient {
  constructor(private readonly webhookSecret: string) {}

  verifyWebhook(payload: string | Buffer, signature: string): StripeWebhookEvent {
    if (signature !== this.webhookSecret) throw new StripeSignatureError();
    const text = typeof payload === 'string' ? payload : payload.toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new StripeSignatureError('unparseable webhook payload');
    }
    const ev = parsed as Partial<StripeWebhookEvent>;
    if (!ev.id || !ev.type) throw new StripeSignatureError('missing id/type');
    return { id: ev.id, type: ev.type, data: ev.data ?? { object: {} } };
  }

  async reportMeterEvent(input: MeterEventInput): Promise<{ id: string }> {
    // Deterministic id keyed on the idempotency identifier.
    return { id: `mev_fake_${input.identifier}` };
  }
}

export interface RealStripeOptions {
  apiKey: string;
  webhookSecret: string;
}

/** STUB. Real Stripe wiring for Phase-1; SDK loaded lazily. */
export class RealStripeClient implements StripeClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  constructor(private readonly opts: RealStripeOptions) {}

  private async sdk(): Promise<void> {
    if (this.client) return;
    // Specifier via a variable so the optional `stripe` dep is not statically
    // resolved at type-check time (Phase-0 uses FakeStripeClient).
    const stripeModule = 'stripe';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(stripeModule);
    const Stripe = mod.default ?? mod;
    this.client = new Stripe(this.opts.apiKey);
  }

  verifyWebhook(_payload: string | Buffer, _signature: string): StripeWebhookEvent {
    // STUB: real impl is async (loads SDK); wire via a preload in server.ts.
    // Kept synchronous to match the interface; Phase-0 uses FakeStripeClient.
    throw new Error('RealStripeClient.verifyWebhook is a Phase-1 stub — use FakeStripeClient in Phase-0');
  }

  async reportMeterEvent(input: MeterEventInput): Promise<{ id: string }> {
    await this.sdk();
    // STUB shape: real call is client.billing.meterEvents.create(...).
    const res = await this.client.billing.meterEvents.create({
      event_name: input.eventName,
      identifier: input.identifier,
      payload: { stripe_customer_id: input.stripeCustomerId, value: String(input.value) },
    });
    return { id: res.identifier ?? input.identifier };
  }
}
