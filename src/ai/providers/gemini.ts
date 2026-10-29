import type { ChatMessage, Decoder, EmitHandlers, Provider, StreamRequest } from '../types';
import { geminiThinkingPlan } from '../effort';
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

function toContents(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  }));
}

function readUsage(record: Record<string, unknown>, emit: EmitHandlers): void {
  const usage = asRecord(record.usageMetadata);
  if (!usage) return;
  emit.usage({
    input: asNumber(usage.promptTokenCount),
    output: asNumber(usage.candidatesTokenCount),
    reasoning: asNumber(usage.thoughtsTokenCount),
    cachedInput: asNumber(usage.cachedContentTokenCount),
  });
}

function readParts(candidate: Record<string, unknown>, emit: EmitHandlers): void {
  const content = asRecord(candidate.content);
  if (!content) return;
  for (const part of asArray(content.parts)) {
    const item = asRecord(part);
    if (!item) continue;
    const text = asString(item.text);
    if (!text) continue;
    if (item.thought === true) emit.reasoning(text);
    else emit.text(text);
  }
}

function buildUrl(cfg: { baseUrl: string; model: string; stream: boolean }): string {
  // The official docs spell the model as `models/gemini-...`; strip that
  // prefix so it is not doubled into `/models/models%2F...`.
  const model = cfg.model.trim().replace(/^models\//i, '');
  const suffix = cfg.stream
    ? `/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
    : `/models/${encodeURIComponent(model)}:generateContent`;
  return joinUrl(cfg.baseUrl, suffix);
}

export const gemini: Provider = {
  id: 'gemini',
  label: 'Google Gemini',
  hint: 'POST {base}/models/{model}:streamGenerateContent · 原生 Gemini API，thinking 会作为思维链显示',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  defaultModel: 'gemini-2.5-pro',

  buildRequest(cfg, system, messages, stream): StreamRequest {
    const plan = geminiThinkingPlan(cfg.model, cfg.effort, cfg.thinkingMode, cfg.effortCustom);
    // Thinking tokens count against maxOutputTokens on 2.5. A budget larger than
    // the output cap would truncate the answer (or be rejected outright), so
    // always leave room for the actual move.
    const maxOutputTokens =
      cfg.reasoning && plan.kind === 'budget' && plan.budget > 0
        ? Math.max(cfg.maxTokens, plan.budget + 1024)
        : cfg.maxTokens;
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: system }] },
      contents: toContents(messages),
      generationConfig: {
        maxOutputTokens,
        ...(cfg.reasoning
          ? {
              thinkingConfig: {
                includeThoughts: true,
                // Gemini 3+ only understands `thinkingLevel`; 2.5 wants tokens.
                ...(plan.kind === 'level'
                  ? { thinkingLevel: plan.level }
                  : { thinkingBudget: plan.budget }),
              },
            }
          : {}),
      },
    };
    return {
      url: buildUrl({ baseUrl: cfg.baseUrl, model: cfg.model, stream }),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': cfg.apiKey,
        ...parseExtraHeaders(cfg.extraHeaders),
      },
      body: JSON.stringify(body),
      timeout_secs: cfg.timeoutSecs,
      insecure_tls: cfg.insecureTls,
    };
  },

  createDecoder(_cfg, emit): Decoder {
    let finished = false;
    const reader = new SseReader((_event, data) => {
      if (finished) return;
      const payload = asRecord(tryParseJson(data));
      if (!payload) return;
      if (payload.error) {
        const error = asRecord(payload.error) ?? payload;
        finished = true;
        emit.error(null, asString(error.message) ?? JSON.stringify(error));
        return;
      }
      readUsage(payload, emit);
      const candidate = asRecord(asArray(payload.candidates)[0]);
      if (!candidate) return;
      readParts(candidate, emit);
      if (asString(candidate.finishReason)) {
        finished = true;
        emit.done();
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
    if (record.error) {
      const error = asRecord(record.error) ?? record;
      emit.error(null, asString(error.message) ?? JSON.stringify(error));
      return;
    }
    readUsage(record, emit);
    const candidate = asRecord(asArray(record.candidates)[0]);
    if (candidate) readParts(candidate, emit);
    emit.done();
  },
};
