import type { AuthSession } from './auth-state';

export enum PanelGateReason {
  NONE = 'none',
  ANONYMOUS = 'anonymous',
  FREE_TIER = 'free_tier',
}

/** Premium access is always granted — no gating. */
export function hasPremiumAccess(_authState?: AuthSession): boolean {
  return true;
}

/** All panels are ungated — always returns NONE. */
export function getPanelGateReason(
  _authState: AuthSession,
  _isPremium: boolean,
): PanelGateReason {
  return PanelGateReason.NONE;
}
