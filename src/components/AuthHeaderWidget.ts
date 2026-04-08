import { subscribeAuthState, type AuthSession } from '@/services/auth-state';
import { mountUserButton } from '@/services/clerk';

export class AuthHeaderWidget {
  private container: HTMLElement;
  private unsubscribeAuth: (() => void) | null = null;
  private unmountUserButton: (() => void) | null = null;

  constructor(_onSignInClick?: () => void, _onSettingsClick?: () => void) {
    this.container = document.createElement('div');
    this.container.className = 'auth-header-widget';

    this.unsubscribeAuth = subscribeAuthState((state: AuthSession) => {
      if (state.isPending) {
        this.container.innerHTML = '';
        return;
      }
      this.render(state);
    });
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.unmountUserButton?.();
    this.unmountUserButton = null;
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth();
      this.unsubscribeAuth = null;
    }
  }

  private render(state: AuthSession): void {
    // Cleanup previous Clerk mount
    this.unmountUserButton?.();
    this.unmountUserButton = null;
    this.container.innerHTML = '';

    if (!state.user) {
      // No sign-in button -- silent anonymous state
      return;
    }

    // Signed in -- mount Clerk UserButton
    const userBtnEl = document.createElement('div');
    userBtnEl.className = 'auth-clerk-user-button';
    this.container.appendChild(userBtnEl);
    this.unmountUserButton = mountUserButton(userBtnEl);
  }
}
