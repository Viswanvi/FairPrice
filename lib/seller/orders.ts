/**
 * Pure helpers for the orders dashboard. Wording follows the copy rules (CLAUDE.md, SPEC §10):
 * never accuse ("Country mismatch", not "VPN"), and always say whether money moved.
 */

export type Decision = "MATCH" | "TRAVELER" | "MISMATCH" | "UNCLEAR" | "NOT_PAYPAL";
export type Status = "CREATED" | "AUTHORIZED" | "CAPTURED" | "VOIDED" | "DECLINED" | "NEEDS_REVIEW";
export type Tone = "ok" | "accent" | "warn" | "neutral" | "danger" | "muted";

export const DECISIONS: readonly Decision[] = ["MATCH", "TRAVELER", "MISMATCH", "UNCLEAR", "NOT_PAYPAL"];

export const DECISION_INFO: Record<Decision, { label: string; tone: Tone; help: string }> = {
  MATCH: { label: "Match", tone: "ok", help: "Paid the fair price for their PayPal account's country." },
  TRAVELER: { label: "Traveler", tone: "accent", help: "Charged their own country's lower fair price instead of the price shown." },
  MISMATCH: { label: "Country mismatch", tone: "warn", help: "Not charged. Their PayPal account's country has a higher price; they were offered it." },
  UNCLEAR: { label: "Unclear", tone: "neutral", help: "Not charged. PayPal didn't confirm a country; they were offered the standard price." },
  NOT_PAYPAL: { label: "Not PayPal", tone: "neutral", help: "Not charged. Paid by card without a PayPal account; offered the standard price." },
};

export const STATUS_INFO: Record<Status, { label: string; tone: Tone }> = {
  CREATED: { label: "Awaiting buyer", tone: "muted" },
  AUTHORIZED: { label: "Deciding", tone: "muted" },
  CAPTURED: { label: "Captured", tone: "ok" },
  VOIDED: { label: "Voided", tone: "neutral" },
  DECLINED: { label: "Declined", tone: "neutral" },
  NEEDS_REVIEW: { label: "Needs review", tone: "danger" },
};

export interface OrderLike {
  status: Status;
  decision: Decision | null;
  chargedCents: number | null;
}

export interface OrdersSummary {
  total: number;
  captured: number;
  capturedCents: number;
  notCharged: number;
  needsReview: number;
  inProgress: number;
  byDecision: Record<Decision, number>;
}

export function summarizeOrders(orders: ReadonlyArray<OrderLike>): OrdersSummary {
  const byDecision = Object.fromEntries(DECISIONS.map((d) => [d, 0])) as Record<Decision, number>;
  const summary: OrdersSummary = {
    total: orders.length,
    captured: 0,
    capturedCents: 0,
    notCharged: 0,
    needsReview: 0,
    inProgress: 0,
    byDecision,
  };
  for (const o of orders) {
    if (o.decision) byDecision[o.decision]++;
    if (o.status === "CAPTURED") {
      summary.captured++;
      summary.capturedCents += o.chargedCents ?? 0;
    } else if (o.status === "VOIDED" || o.status === "DECLINED") {
      summary.notCharged++;
    } else if (o.status === "NEEDS_REVIEW") {
      summary.needsReview++;
    } else {
      summary.inProgress++;
    }
  }
  return summary;
}

/** "just now", "42s ago", "5 min ago", "3 h ago", then "2 d ago". */
export function relativeTime(iso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
