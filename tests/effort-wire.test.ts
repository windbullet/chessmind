import { describe, expect, it } from 'vitest';
import { openaiChat } from '../src/ai/providers/openaiChat';
import { openaiResponses } from '../src/ai/providers/openaiResponses';
import { anthropic } from '../src/ai/providers/anthropic';
import { DEFAULT_AI } from '../src/config';
import type { AiConfig } from '../src/ai/types';

function cfg(overrides: Partial<AiConfig> = {}): AiConfig {
  return { ...DEFAULT_AI, apiKey: 'sk-test', ...overrides };
}

const MSGS = [{ role: 'user' as const, content: 'move?' }];

describe('custom effort reaches the wire', () => {
  it('OpenAI Chat uses the custom text in reasoning_effort', () => {
    const body = JSON.parse(
      openaiChat.buildRequest(cfg({ effortCustom: 'minimal' }), 'sys', MSGS, true).body,
    );
    expect(body.reasoning_effort).toBe('minimal');
  });

  it('OpenAI Responses uses the custom text in reasoning.effort', () => {
    const body = JSON.parse(
      openaiResponses.buildRequest(cfg({ effortCustom: 'none' }), 'sys', MSGS, true).body,
    );
    expect(body.reasoning.effort).toBe('none');
  });

  it('Claude adaptive uses the custom text in output_config.effort', () => {
    const body = JSON.parse(
      anthropic.buildRequest(
        cfg({ protocol: 'anthropic', model: 'claude-opus-4-7', effortCustom: 'xhigh' }),
        'sys',
        MSGS,
        true,
      ).body,
    );
    expect(body.output_config.effort).toBe('xhigh');
  });

  it('falls back to the preset when the custom text is empty', () => {
    const body = JSON.parse(
      openaiChat.buildRequest(cfg({ effort: 'low', effortCustom: '' }), 'sys', MSGS, true).body,
    );
    expect(body.reasoning_effort).toBe('low');
  });
});
