import type { StreamEvent, StreamRequest } from '../ai/types';

export interface StreamHandlers {
  onEvent(event: StreamEvent): void;
  signal: AbortSignal;
}

export interface Bridge {
  readonly kind: 'tauri' | 'web';
  stream(request: StreamRequest, handlers: StreamHandlers): Promise<void>;
  loadSettings(): Promise<string | null>;
  saveSettings(json: string): Promise<void>;
  appVersion(): Promise<string>;
}

export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.__TAURI_INTERNALS__) || Boolean(w.__TAURI__);
}
