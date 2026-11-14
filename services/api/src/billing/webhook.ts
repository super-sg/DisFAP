/**
 * Stripe webhook handler. Two hard requirements:
 *  1. Verify the signature over the RAW body (never the re-serialized JSON).
 *  2. Idempotency: each `stripe_event_id` is processed at most once, enforced
 *     by the unique constraint on `stripe_events.stripe_event_id`. Stripe
 *     retries aggressively; a duplicate must be a no-op that still returns 200.
 */

import type { StripeClient, StripeWebhookEvent } from './stripe-client.js';

/** Persistence seam for webhook idempotency + subscription upserts. */
export interface StripeEventStore {
  /** Insert the event; return false if this id was already recorded. */
  insertIfNew(stripeEventId: string, type: string, payload: Record<string, unknown>): Promise<boolean>;
  markProcessed(stripeEventId: string, at: Date): Promise<void>;
}

/** Optional sink for subscription lifecycle events (skeleton). */
export interface SubscriptionSink {
  upsertFromStripe(event: StripeWebhookEvent): Promise<void>;
}

export interface WebhookDeps {
  stripe: StripeClient;
  events: StripeEventStore;
  subscriptions?: SubscriptionSink;
  now?: () => Date;
}

export interface WebhookResult {
  received: true;
  duplicate: boolean;
  type: string;
}

/** Types we act on; everything else is recorded but otherwise ignored. */
const SUBSCRIPTION_TYPES: ReadonlySet<string> = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

export async function handleStripeWebhook(
  rawBody: string | Buffer,
  signature: string,
  deps: WebhookDeps,
): Promise<WebhookResult> {
  // (1) Verify signature over the raw bytes. Throws StripeSignatureError (400).
  const event = deps.stripe.verifyWebhook(rawBody, signature);

  // (2) Idempotency: unique stripe_event_id. Duplicate => 200 no-op.
  const isNew = await deps.events.insertIfNew(event.id, event.type, event.data as unknown as Record<string, unknown>);
  if (!isNew) return { received: true, duplicate: true, type: event.type };

  // (3) Process (skeleton): keep subscriptions in sync; extend as needed.
  if (deps.subscriptions && SUBSCRIPTION_TYPES.has(event.type)) {
    await deps.subscriptions.upsertFromStripe(event);
  }

  await deps.events.markProcessed(event.id, (deps.now ?? (() => new Date()))());
  return { received: true, duplicate: false, type: event.type };
}
