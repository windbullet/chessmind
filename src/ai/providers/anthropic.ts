import type { Decoder, EmitHandlers, Provider, StreamRequest } from '../types';
import { anthropicThinkingPlan } from '../effort';
import {
  SseReader,
  asArray,
  asNumber,
  asRecord,
  asString,
  joinUrl,
  parseExtraHeaders,
  tryParseJson,
} from './common';


/**
 * Anthropic reports the three input buckets separately; `input_tokens` alone
 * excludes cached tokens, so add them back to get the true prompt size.
 *
 * Events may carry only part of the picture — `message_start` has the input
 * counts, while a plain `message_delta` has only `output_tokens`. So only
 * report `input` when this event actually carried input information; the
 * client merges defined fields, so silence leaves earlier values intact.
 */
function readUsage(usage: Record<string, unknown>, emit: EmitHandlers): void {
  const cached = asNumber(usage.cache_read_input_tokens);
  const written = asNumber(usage.cache_creation_input_tokens);
  const fresh = asNumber(usage.input_tokens);
  const hasInput = fresh !== undefined || cached !== undefined || written !== undefined;
  emit.usage({
    ...(hasInput ? { input: (fresh ?? 0) + (cached ?? 0) + (written ?? 0) } : {}),
    output: asNumber(usage.output_tokens),
    cachedInput: cached,
    cacheWrite: written,
  });
}

export const anthropic: Provider = {
  id: 'anthropic',
  label: 'Anthropic Messages',
  hint: 'POST {base}/messages · Claude 系列，支持 thinking 思维链流式返回',
  defaultBaseUrl: 'https://api.anthropic.com/v1',
  defaultModel: 'claude-sonnet-4-6',

  buildRequest(cfg, system, messages, stream): StreamRequest {
    // Anthropic caches on explicit breakpoints. Put one at the end of the
    // (byte-stable) system prompt, and at the last history message the
    // coordinator flagged, so continuous context keeps hitting the prefix cache.
    const anyCacheable = messages.some((message) => message.cache);
    const body: Record<string, unknown> = {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      system: anyCacheable
        ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
        : system,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.cache
          ? [
              {
                type: 'text',
                text: message.content,
                cache_control: { type: 'ephemeral' as const },
              },
            ]
          : message.content,
      })),
      stream,
    };
    if (cfg.reasoning) {
      const plan = anthropicThinkingPlan(
        cfg.model,
        cfg.effort,
        cfg.maxTokens,
        cfg.thinkingMode,
        cfg.effortCustom,
      );
      body.thinking = plan.thinking;
      body.max_tokens = plan.maxTokens;
      if (plan.mode === 'adaptive') {
        // 4.6+ replaced fixed thinking budgets with a single effort knob.
        body.output_config = { effort: plan.effort };
      }
    }
    return {
      url: joinUrl(cfg.baseUrl, '/messages'),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        ...parseExtraHeaders(cfg.extraHeaders),
      },
      body: JSON.stringify(body),
      timeout_secs: cfg.timeoutSecs,
      insecure_tls: cfg.insecureTls,
    };
  },

  createDecoder(_cfg, emit): Decoder {
    let finished = false;
    const reader = new SseReader((event, data) => {
      if (finished) return;
      const payload = asRecord(tryParseJson(data));
      if (!payload) return;
      const type = asString(payload.type) ?? event;
      switch (type) {
        case 'message_start': {
          // Input and cache token counts arrive here, once, in the initial
          // Message object — `message_delta` only carries output tokens.
          const message = asRecord(payload.message);
          const usage = message ? asRecord(message.usage) : null;
          if (usage) readUsage(usage, emit);
          break;
        }
        case 'content_block_delta': {
          const delta = asRecord(payload.delta);
          if (!delta) break;
          const deltaType = asString(delta.type);
          if (deltaType === 'text_delta') {
            const text = asString(delta.text);
            if (text) emit.text(text);
          } else if (deltaType === 'thinking_delta') {
            const thinking = asString(delta.thinking);
            if (thinking) emit.reasoning(thinking);
          }
          break;
        }
        case 'message_delta': {
          // Normally only cumulative output tokens; some responses (e.g. with
          // server-side tool use) repeat the full input/cache counts here too.
          // Emitting them is harmless — the client merges defined fields.
          const usage = asRecord(payload.usage);
          if (usage) readUsage(usage, emit);
          break;
        }
        case 'message_stop': {
          finished = true;
          emit.done();
          break;
        }
        case 'error': {
          const error = asRecord(payload.error) ?? payload;
          finished = true;
          emit.error(null, asString(error.message) ?? JSON.stringify(error));
          break;
        }
        default:
          break;
      }
    });
    return {
      push: (chunk) => reader.push(chunk),
      end: () => {
        reader.end();
        if (!finished) {
          finished = true;
          emit.done();
        }
      },
    };
  },

  parseFull(payload, emit) {
    const record = asRecord(payload);
    if (!record) {
      emit.error(null, '无法解析响应');
      return;
    }
    if (record.type === 'error') {
      const error = asRecord(record.error) ?? record;
      emit.error(null, asString(error.message) ?? JSON.stringify(error));
      return;
    }
    for (const block of asArray(record.content)) {
      const item = asRecord(block);
      if (!item) continue;
      const type = asString(item.type);
      if (type === 'text') {
        const text = asString(item.text);
        if (text) emit.text(text);
      } else if (type === 'thinking') {
        const thinking = asString(item.thinking);
        if (thinking) emit.reasoning(thinking);
      }
    }
    const usage = asRecord(record.usage);
    if (usage) readUsage(usage, emit);
    emit.done();
  },
};
