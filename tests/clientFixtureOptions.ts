// Only the guarded disposable fixture CLI consumes this option. Never infer
// test opt-in from the production feature flag or load an environment file.
export function clientFixtureOptions(args: readonly string[]): { logoutSync: boolean } {
  if (args.length === 0) return { logoutSync: false };
  if (args.length === 1 && args[0] === '--logout-sync') return { logoutSync: true };
  throw new Error('fixture_invalid_options');
}
