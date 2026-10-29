import { useGame } from './game/store';
import { useSettings } from './settings';

declare global {
  interface Window {
    __CHESSMIND__?: {
      game: typeof useGame;
      settings: typeof useSettings;
      click(square: string): void;
    };
  }
}

/**
 * A tiny automation hook. It only exposes the same stores the UI already uses,
 * so the app can be driven by scripts (screenshots / smoke tests) without a
 * test-only build.
 */
export function installDebugBridge(): void {
  if (typeof window === 'undefined') return;
  // Never expose the live stores (which contain the API keys) in a production
  // build: any script that reaches the WebView could read them.
  if (!import.meta.env.DEV) return;
  window.__CHESSMIND__ = {
    game: useGame,
    settings: useSettings,
    click(square: string) {
      const element = document.querySelector<HTMLElement>(`[data-square="${square}"]`);
      element?.click();
    },
  };
}
