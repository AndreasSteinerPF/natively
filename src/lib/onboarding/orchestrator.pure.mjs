/**
 * OnboardingOrchestrator — .mjs companion exposing the pure decision-engine
 * function for unit tests under `node --test`.
 *
 * The full class (with RAF, pub/sub, event bus) lives in orchestrator.ts. This
 * file re-implements `shouldShowToaster` as a pure function with the same
 * logic so tests can exercise it without DOM polyfills.
 */

/**
 * Pure decision function — given a stage config and a context, returns whether
 * the toaster should fire. Mirrors `OnboardingOrchestrator.shouldShowToaster`.
 */
export function shouldShowToaster(config, ctx) {
  // 1. Hard skip — user-state
  if (config.skipWhen && config.skipWhen(ctx.userState)) return false;

  // 2. Already done forever
  if (
    config.onceEver &&
    ctx.completed[config.id] &&
    !(config.reEligibility && config.reEligibility(ctx.userState, ctx.completed))
  ) {
    return false;
  }

  // 3. Cooldown
  const lastShown = ctx.lastShownTimes[config.id] ?? 0;
  const cooldownMs = config.cooldownMs ? config.cooldownMs(ctx.userState) : 0;
  if (cooldownMs > 0 && ctx.now - lastShown < cooldownMs) return false;

  // 4. Prerequisites
  if (config.requiresStages) {
    for (const dep of config.requiresStages) {
      if (!ctx.completed[dep] && !ctx.skipped.has(dep)) return false;
    }
  }

  // 5. Soft triggers
  const t = config.triggers || {};
  if (t.requiresHomepageMounted && !ctx.homepageCurrentlyMounted) return false;
  if (t.requiresHomepageDuration != null && ctx.homepageMountedFor < t.requiresHomepageDuration) return false;
  if (t.requiresStartupCount != null && ctx.startupCount < t.requiresStartupCount) return false;
  if (t.requiresTurnCount != null && ctx.turnCount < t.requiresTurnCount) return false;
  if (t.requiresTotalUsageMs != null && ctx.totalUsageMs < t.requiresTotalUsageMs) return false;
  if (t.requiresForeground && !ctx.appInForeground) return false;
  if (t.requiresMeetingInactive && ctx.meetingActive) return false;

  // 6. Custom predicate
  if (config.customPredicate && !config.customPredicate(ctx)) return false;

  return true;
}

/**
 * Default UserState — mirrors the orchestrator.ts source-of-truth so the
 * pure-function tests can build fixture contexts without importing the
 * DOM/RAF-bound class.
 */
export const DEFAULT_USER_STATE = {
  isPremium: false,
  hasProfile: false,
  hasNativelyKey: false,
  hasTrialToken: false,
  extensionConnected: false,
  extensionSupported: true,
  permsShown: false,
  macTCCBlocked: false,
  seenProfileOnboarding: false,
  seenModesOnboarding: false,
  activeModeSet: false,
  donationShouldShow: false,
  isV2_8_OrNewer: true,
};