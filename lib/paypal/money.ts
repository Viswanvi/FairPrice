/**
 * The only place cents become PayPal amount strings and back (CLAUDE.md money-safety rule 2).
 * Exact string arithmetic — never floating point. USD only.
 */

export function centsToValue(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError("amount must be a non-negative whole number of cents");
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** "35.00" → 3500, "35" → 3500, "34.9" → 3490. Throws on anything else. */
export function valueToCents(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new RangeError(`not a USD amount: ${JSON.stringify(value)}`);
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new RangeError("amount too large");
  return cents;
}
