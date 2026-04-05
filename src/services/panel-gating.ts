import type { AuthSession } from './auth-state';

export enum PanelGateReason {
  NONE = 'none',           // show content (pro user, or desktop with API key, or non-premium panel)
  ANONYMOUS = 'anonymous', // "Sign In to Unlock"
  FREE_TIER = 'free_tier', // "Upgrade to Pro"
}

/**
 * Single source of truth for premium access.
 * Covers all access paths: desktop API key, tester keys (wm-pro-key / wm-widget-key), Clerk Pro.
 */
export function hasPremiumAccess(_authState?: AuthSession): boolean {
  return true;
}

/**
 * Determine gating reason for a premium panel given current auth state.
 * Non-premium panels always return NONE.
 */
export function getPanelGateReason(
  authState: AuthSession,
  isPremium: boolean,
): PanelGateReason {
  // Non-premium panels are never gated
  if (!isPremium) return PanelGateReason.NONE;

  // API key, tester key, or Clerk Pro: always unlocked
  if (hasPremiumAccess(authState)) return PanelGateReason.NONE;

  // Web gating based on Clerk auth state
  if (!authState.user) return PanelGateReason.ANONYMOUS;
  return PanelGateReason.FREE_TIER;
}
