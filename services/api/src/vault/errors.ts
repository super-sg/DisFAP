/**
 * Vault error types, kept in their own module so the auth layer and the HTTP
 * client can both throw them without an import cycle.
 *
 * Invariant: no error ever carries a token, a secret value, or a response body.
 * Only a status code and a fixed message are allowed — these errors reach logs
 * and (for 4xx) HTTP responses.
 */

/** A Vault HTTP call failed. Carries only a status — never a token or body. */
export class VaultRequestError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'VaultRequestError';
    if (status !== undefined) this.status = status;
  }
}

/** Vault authentication (AppRole login / token load) could not produce a token. */
export class VaultAuthError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'VaultAuthError';
    if (status !== undefined) this.status = status;
  }
}

export class WrapTokenConsumedError extends Error {
  constructor() {
    super('vault wrap token already consumed, expired, or unknown');
    this.name = 'WrapTokenConsumedError';
  }
}
