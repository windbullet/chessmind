import type { Provider } from '../types';
import { anthropic } from './anthropic';
import { gemini } from './gemini';
import { openaiChat } from './openaiChat';
import { openaiResponses } from './openaiResponses';

export const providers: Provider[] = [openaiChat, openaiResponses, anthropic, gemini];

export function getProvider(id: Provider['id']): Provider {
  return providers.find((provider) => provider.id === id) ?? openaiChat;
}

export const PROTOCOL_OPTIONS = providers.map((provider) => ({
  value: provider.id,
  label: provider.label,
  hint: provider.hint,
}));
