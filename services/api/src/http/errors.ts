/**
 * HTTP error translation shared by the app factory.
 *
 * Domain/services signal a client-visible outcome by attaching a numeric
 * `statusCode`; anything else is an internal failure. The distinction matters
 * because the two paths have very different audiences: a 4xx message is the
 * actionable answer to the caller, a 5xx body must never carry driver text,
 * hostnames, SQL, or a stack.
 */

export function statusOf(err: unknown): number {
  const code = (err as { statusCode?: unknown })?.statusCode;
  return typeof code === 'number' ? code : 500;
}

/** True when the error is a client-fault outcome that is safe to describe. */
export function isClientError(err: unknown): boolean {
  const status = statusOf(err);
  return status >= 400 && status < 500;
}
