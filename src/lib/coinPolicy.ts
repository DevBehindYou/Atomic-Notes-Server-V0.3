/** Calendar months in UTC, clamped at month end. A credit never borrows a client clock. */
export function coinExpiry(creditedAt: Date): Date {
  const result = new Date(creditedAt);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 6);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/** Absent by default. Setting this is a separately authorized production migration/activation. */
export function coinPolicyActivation(now = new Date()): Date | null {
  const value = process.env.COIN_EXPIRY_ACTIVATED_AT;
  if (!value) return null;
  // Require an explicit UTC instant; ambiguous local dates must never activate an economy policy.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('Invalid COIN_EXPIRY_ACTIVATED_AT');
  }
  const at = new Date(value);
  return now >= at ? at : null;
}
