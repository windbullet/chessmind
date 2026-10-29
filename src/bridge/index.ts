import { tauriBridge } from './tauri';
import { isTauri } from './types';
import type { Bridge } from './types';
import { webBridge } from './web';

export const bridge: Bridge = isTauri() ? tauriBridge : webBridge;

export type { Bridge } from './types';
export { isTauri } from './types';
