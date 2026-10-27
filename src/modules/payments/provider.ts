import { hmacHex } from "../../lib/crypto.js";

export interface CreateIntentInput {
  paymentId: string;
  amountMinor: number;
  currency: string;
}
export interface PaymentIntent {
  providerPaymentId: string;
  checkoutUrl: string;
}

/**
 * Port for the PSP (Razorpay/Stripe/…). Every call carries an idempotency key (our payment id) so the job queue can
 * retry freely after timeouts without double-charging or double-refunding.
 */
export interface PaymentProvider {
  readonly name: string;
  createIntent(input: CreateIntentInput): Promise<PaymentIntent>;
  refund(input: { providerPaymentId: string; amountMinor: number; idempotencyKey: string }): Promise<{ providerRefundId: string }>;
}

/** Deterministic in-memory PSP for dev/test. Supports failure injection to exercise retry/backoff paths. */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";
  readonly intents: CreateIntentInput[] = [];
  readonly refunds: string[] = [];
  private failures = 0;

  /** Make the next `n` provider calls throw (simulates a PSP outage). */
  failNext(n: number): void {
    this.failures = n;
  }
  private maybeFail() {
    if (this.failures > 0) {
      this.failures--;
      throw new Error("mock provider unavailable");
    }
  }

  async createIntent(input: CreateIntentInput): Promise<PaymentIntent> {
    this.maybeFail();
    this.intents.push(input);
    return { providerPaymentId: `mock_pay_${input.paymentId}`, checkoutUrl: `https://pay.mock.local/checkout/${input.paymentId}` };
  }

  async refund(input: { providerPaymentId: string; amountMinor: number; idempotencyKey: string }) {
    this.maybeFail();
    if (!this.refunds.includes(input.idempotencyKey)) this.refunds.push(input.idempotencyKey);
    return { providerRefundId: `mock_ref_${input.idempotencyKey}` };
  }
}

export const WEBHOOK_TOLERANCE_SEC = 300;

/** Header format: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`. Timestamp binding limits replay to the tolerance window. */
export function signWebhook(secret: string, rawBody: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${hmacHex(secret, `${t}.${rawBody}`)}`;
}

export function parseSignatureHeader(header: string): { t: number; v1: string } | null {
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  return Number.isFinite(t) && parts.v1 ? { t, v1: parts.v1 } : null;
}
