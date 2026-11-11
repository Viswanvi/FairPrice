/**
 * Errors from the PayPal client. Messages carry PayPal's error name, issue and debug_id —
 * never tokens, credentials or buyer data.
 */

/** PayPal answered with an error status, or the request didn't complete (status 0). */
export class PayPalError extends Error {
  constructor(
    /** HTTP status; 0 for network errors and timeouts. */
    public readonly status: number,
    /** PayPal's error name, e.g. UNPROCESSABLE_ENTITY, or NETWORK_ERROR. */
    public readonly paypalName: string,
    message: string,
    public readonly debugId: string | null = null,
    /** First `details[].issue`, e.g. AUTHORIZATION_ALREADY_CAPTURED. */
    public readonly issue: string | null = null,
  ) {
    super(message);
    this.name = "PayPalError";
  }

  /** Worth retrying with the same PayPal-Request-Id (network error or 5xx). */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

/** PayPal answered 2xx but the body didn't contain a field we rely on. Don't guess — stop. */
export class PayPalResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayPalResponseError";
  }
}

/** PAYPAL_WEBHOOK_ID isn't set, so webhooks can't be verified (route answers 503). */
export class WebhookConfigError extends Error {
  constructor() {
    super("PAYPAL_WEBHOOK_ID is not set, so webhook signatures can't be verified.");
    this.name = "WebhookConfigError";
  }
}
