/** Shared pricing constants; importing policy must not initialize MongoDB. */
export const ENERGY = {
  coinToEnergy: 40,
  dailyGrant: 20,
  syncStandardCost: 5,
  syncInstantCost: 10,
  defaultEnergyCap: 120,
  /** Standard sync once per interval by the Server clock; instant has no interval. */
  standardSyncIntervalMs: 60 * 60 * 1000,
  dailyGrantWindowMs: 24 * 60 * 60 * 1000,
} as const;
