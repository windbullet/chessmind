import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import type { AiConfig } from '../src/ai/types';

/** Requests the coordinator actually sent, plus any notices it surfaced. */
const h = vi.hoisted(() => ({
  calls: [] as Array<{ effort: string; reasoning: boolean }>,
  notices: [] as string[],
  rejectEffortAboveHigh: true,
  rejectReasoningEverywhere: false,
}));

vi.mock('../src/ai/client', () => ({
  runAttempt: async (opts: { cfg: { effort: string; reasoning: boolean } }) => {
    const { effort, reasoning } = opts.cfg;
    h.calls.push({ effort, reasoning });
    const fail = (error: string) => ({
      status: 400,
      aborted: false,
      error,
      usage: null,
      text: '',
      reasoning: '',
    });
    if (h.rejectReasoningEverywhere && reasoning) {
      return fail("Unsupported parameter: 'reasoning_effort' is not supported with this model.");
    }
    if (h.rejectEffortAboveHigh && (effort === 'xhigh' || effort === 'max')) {
      return fail(`Unsupported value: 'reasoning_effort' does not support '${effort}' with this model.`);
    }
    return {
      status: 200,
      aborted: false,
      error: null,
      usage: null,
      text: '{"move_uci":"e2e4","move_san":"e4"}',
      reasoning: '',
    };
  },
}));

const { requestAiMove } = await import('../src/ai/coordinator');

function cfg(effort: AiConfig['effort'], model: string): AiConfig {
  return {
    protocol: 'openai-chat',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model,
    extraHeaders: '',
    stream: true,
    reasoning: true,
    effort,
    effortCustom: '',
    thinkingMode: 'auto',
    context: 'continuous',
    contextBudget: 64_000,
    maxTokens: 4096,
    timeoutSecs: 120,
    retries: 3,
    insecureTls: false,
  };
}

function callbacks() {
  return {
    onAttemptStart: () => {},
    onReasoning: () => {},
    onText: () => {},
    onAttemptEnd: () => {},
    onNotice: (message: string) => {
      h.notices.push(message);
    },
  };
}

/**
 * `model` doubles as the cache key for learned effort ceilings, so every test
 * passes its own name to stay independent from the others.
 */
function turn(effort: AiConfig['effort'], model: string) {
  return requestAiMove(
    {
      cfg: cfg(effort, model),
      side: 'w',
      chess: new Chess(),
      history: [],
      edited: false,
      commentary: false,
      lang: 'zh',
      opponent: 'human',
      exchanges: [],
      signal: new AbortController().signal,
    },
    callbacks(),
  );
}

beforeEach(() => {
  h.calls.length = 0;
  h.notices.length = 0;
  h.rejectEffortAboveHigh = true;
  h.rejectReasoningEverywhere = false;
});

describe('effort fallback', () => {
  it('drops xhigh/max to high once, then keeps going', async () => {
    const outcome = await turn('max', 'm-drop');
    expect(outcome.ok).toBe(true);
    expect(h.calls).toEqual([
      { effort: 'max', reasoning: true },
      { effort: 'high', reasoning: true },
    ]);
    expect(h.notices.join('\n')).toContain('降为 high');
    if (outcome.ok) expect(outcome.attempts).toHaveLength(1);
  });

  it('does not retry when the model already accepts xhigh', async () => {
    h.rejectEffortAboveHigh = false;
    const outcome = await turn('xhigh', 'm-accepts');
    expect(outcome.ok).toBe(true);
    expect(h.calls).toEqual([{ effort: 'xhigh', reasoning: true }]);
    expect(h.notices).toHaveLength(0);
  });

  it('strips the reasoning parameter when even high is rejected', async () => {
    h.rejectReasoningEverywhere = true;
    const outcome = await turn('max', 'm-no-reasoning');
    expect(outcome.ok).toBe(true);
    expect(h.calls).toEqual([
      { effort: 'max', reasoning: true },
      { effort: 'high', reasoning: true },
      { effort: 'high', reasoning: false },
    ]);
  });

  it('leaves low/medium/high untouched by the effort step-down', async () => {
    h.rejectEffortAboveHigh = false;
    for (const effort of ['low', 'medium', 'high'] as const) {
      h.calls.length = 0;
      await turn(effort, `m-plain-${effort}`);
      expect(h.calls).toEqual([{ effort, reasoning: true }]);
    }
  });

  it('remembers the refusal and asks for high directly on later turns', async () => {
    await turn('max', 'm-remembered');
    h.calls.length = 0;
    h.notices.length = 0;
    await turn('max', 'm-remembered');
    expect(h.calls).toEqual([{ effort: 'high', reasoning: true }]);
    expect(h.notices).toHaveLength(0);
  });

  it('keeps the learned ceiling per model, not global', async () => {
    await turn('max', 'm-model-a');
    h.calls.length = 0;
    await turn('max', 'm-model-b');
    expect(h.calls).toEqual([
      { effort: 'max', reasoning: true },
      { effort: 'high', reasoning: true },
    ]);
  });
});
