import type { Chess, Move } from 'chess.js';
import type { Side } from '../game/types';
import { runAttempt } from './client';
import {
  estimateTokens,
  exchangeBudget,
  historyMessages,
  trimExchanges,
  type Exchange,
} from './context';
import { buildCorrectionPrompt, buildPositionPrompt, buildSystemPrompt } from './prompt';
import { extractJsonObjects, resolveMove } from './resolveMove';
import { THINKING_EFFORTS } from './types';
import type { AiConfig, AttemptRecord, ChatMessage, ThinkingEffort, Usage } from './types';

export interface TurnCallbacks {
  onAttemptStart(attempt: number, limit: number): void;
  onReasoning(text: string): void;
  onText(text: string): void;
  onAttemptEnd(record: AttemptRecord): void;
  onNotice(message: string): void;
}

export interface TurnOptions {
  cfg: AiConfig;
  side: Side;
  chess: Chess;
  history: string[];
  edited: boolean;
  commentary: boolean;
  lang: string;
  opponent: 'human' | 'ai';
  /** Earlier moves kept in the conversation for continuous context. */
  exchanges: Exchange[];
  signal: AbortSignal;
}

export type TurnOutcome =
  | {
      ok: true;
      move: Move;
      attempts: AttemptRecord[];
      reasoning: string;
      commentary: string | null;
      usage: Usage | null;
      warnings: string[];
      /** The exchange to remember for continuous context (position pack + reply). */
      exchange: Exchange;
    }
  | { ok: false; error: string; attempts: AttemptRecord[] };

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isTransient(status: number | null, message: string): boolean {
  if (status === 429) return true;
  if (status !== null && status >= 500) return true;
  if (status === null) return true;
  return /ECONNRESET|ETIMEDOUT|timed out|timeout|connection|network/i.test(message);
}

function isParameterError(status: number | null, message: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return /max_tokens|max_completion_tokens|max_output_tokens|temperature|reasoning|thinking|budget|unsupported|invalid_request/i.test(
    message,
  );
}

function effortRank(effort: ThinkingEffort): number {
  return THINKING_EFFORTS.indexOf(effort);
}

/** Highest effort a given model accepted, so a refusal costs one request, not every move. */
const effortCeilings = new Map<string, ThinkingEffort>();

/**
 * Models/gateways that rejected the reasoning parameter outright. Remembered per
 * endpoint so every later turn does not pay for the same failed request first.
 */
const reasoningUnsupported = new Set<string>();

function modelKey(cfg: AiConfig): string {
  return `${cfg.protocol}|${cfg.baseUrl}|${cfg.model}`;
}

export function extractCommentary(raw: string): string | null {
  for (const object of extractJsonObjects(raw).reverse()) {
    for (const key of ['commentary', 'comment', 'explanation', 'thoughts']) {
      const value = object[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return null;
}

export async function requestAiMove(opts: TurnOptions, cb: TurnCallbacks): Promise<TurnOutcome> {
  const limit = Math.min(5, Math.max(1, Math.round(opts.cfg.retries) || 1));
  const attempts: AttemptRecord[] = [];
  const continuous = opts.cfg.context === 'continuous';
  const system = buildSystemPrompt(opts.side, {
    commentary: opts.commentary,
    lang: opts.lang,
    opponent: opts.opponent,
    continuous,
  });
  // The current position pack. In continuous mode it is appended *after* the
  // remembered exchanges so the stable prefix (system + old turns) is untouched
  // and the provider's prefix cache keeps hitting.
  const positionPrompt = buildPositionPrompt(opts.chess, {
    side: opts.side,
    history: opts.history,
    edited: opts.edited,
  });
  const movesOnBoard = opts.history.length;
  // Budget covers the whole request: system prompt + remembered turns + this
  // position pack. Remembered turns are trimmed (rarely, in one coarse step)
  // only down to the room that is actually left, so the newest pack always fits.
  const fixedTokens = estimateTokens(system) + estimateTokens(positionPrompt);
  const kept = continuous
    ? trimExchanges(opts.exchanges, exchangeBudget(opts.cfg.contextBudget, fixedTokens))
    : [];
  const historyMsgs = continuous ? historyMessages(kept) : [];
  if (historyMsgs.length > 0) {
    // Cache the stable prefix up to the last remembered reply; the position
    // pack that follows (and the retries inside this turn) stay uncached.
    historyMsgs[historyMsgs.length - 1].cache = true;
  }
  const messages: ChatMessage[] = [
    ...historyMsgs,
    { role: 'user', content: positionPrompt },
  ];
  /**
   * Everything this turn appended after the remembered history: the position
   * pack, plus any rejected reply and its correction prompt. Saved verbatim as
   * the next turn's history so the model sees the same conversation it had.
   */
  const turnMessages: ChatMessage[] = [{ role: 'user', content: positionPrompt }];

  const key = modelKey(opts.cfg);
  const learned = effortCeilings.get(key);
  let cfg: AiConfig =
    learned && effortRank(learned) < effortRank(opts.cfg.effort)
      ? { ...opts.cfg, effort: learned }
      : opts.cfg;
  if (reasoningUnsupported.has(key) && cfg.reasoning) {
    // Already learned that this endpoint rejects the reasoning parameter.
    cfg = { ...cfg, reasoning: false, maxTokens: Math.max(1024, Math.min(cfg.maxTokens, 4096)) };
  }
  /** The model refused `xhigh`/`max`; we already fell back to `high` once. */
  let effortFallback = false;
  /** The model refused the custom effort text; it is back to the preset. */
  let effortTextCleared = false;
  /** The model refused the reasoning param entirely; it is now stripped. */
  let downgraded = false;

  for (let index = 0; index < limit; index += 1) {
    if (opts.signal.aborted) return { ok: false, error: '已取消', attempts };
    cb.onAttemptStart(index + 1, limit);

    let reasoning = '';
    let text = '';
    const started = Date.now();

    const once = () =>
      runAttempt({
        cfg,
        system,
        messages,
        signal: opts.signal,
        cb: {
          onReasoning: (chunk) => {
            reasoning += chunk;
            cb.onReasoning(chunk);
          },
          onText: (chunk) => {
            text += chunk;
            cb.onText(chunk);
          },
        },
      });

    let result = await once();

    if (result.aborted) return { ok: false, error: '已取消', attempts };

    if (result.error && isParameterError(result.status, result.error)) {
      // A custom effort string the model does not know is rejected as a bad
      // parameter. Drop back to the preset level before anything else.
      if (
        !effortTextCleared &&
        cfg.reasoning &&
        cfg.effortCustom.trim().length > 0 &&
        /effort|thinking|reason/i.test(result.error)
      ) {
        effortTextCleared = true;
        cfg = { ...cfg, effortCustom: '' };
        cb.onNotice(`该模型不接受思考强度「${opts.cfg.effortCustom}」，已改回档位重试…`);
        reasoning = '';
        text = '';
        index -= 1;
        continue;
      }

      // Some models take `reasoning_effort` but not its top two levels. Step down
      // to `high` once and keep thinking enabled instead of dropping it entirely.
      const effortRejected =
        !effortFallback &&
        cfg.reasoning &&
        (cfg.effort === 'xhigh' || cfg.effort === 'max') &&
        /reason|effort|think/i.test(result.error);
      if (effortRejected) {
        effortFallback = true;
        effortCeilings.set(key, 'high');
        cfg = { ...cfg, effort: 'high' };
        cb.onNotice(`该模型不接受 reasoning_effort=${opts.cfg.effort}，已降为 high 重试…`);
        reasoning = '';
        text = '';
        index -= 1;
        continue;
      }

      if (!downgraded) {
        downgraded = true;
        reasoningUnsupported.add(key);
        cfg = {
          ...cfg,
          reasoning: false,
          maxTokens: Math.max(1024, Math.min(cfg.maxTokens, 4096)),
        };
        cb.onNotice('网关拒绝了思考/长度参数，已自动降级参数重试…');
        reasoning = '';
        text = '';
        index -= 1;
        continue;
      }
    }

    if (result.error && isTransient(result.status, result.error)) {
      cb.onNotice(`请求失败（${result.status ?? '网络错误'}），1.2 秒后自动重试…`);
      await delay(1200, opts.signal);
      if (opts.signal.aborted) return { ok: false, error: '已取消', attempts };
      reasoning = '';
      text = '';
      result = await once();
      if (result.aborted) return { ok: false, error: '已取消', attempts };
    }

    const elapsedMs = Date.now() - started;
    const raw = (result.text || result.reasoning).trim();

    if (result.error) {
      const record: AttemptRecord = {
        index: index + 1,
        reasoning,
        text,
        raw,
        error: `请求失败：${result.error}`,
        elapsedMs,
        usage: result.usage,
        status: result.status,
        notice: null,
      };
      attempts.push(record);
      cb.onAttemptEnd(record);
      if (index + 1 < limit) {
        cb.onNotice('请求失败，正在重试…');
        await delay(800, opts.signal);
      }
      continue;
    }

    const resolved = resolveMove(raw, opts.chess);
    if (resolved.ok) {
      const record: AttemptRecord = {
        index: index + 1,
        reasoning,
        text,
        raw,
        error: null,
        elapsedMs,
        usage: result.usage,
        status: result.status,
        notice: resolved.value.warnings.length > 0 ? resolved.value.warnings.join('；') : null,
      };
      attempts.push(record);
      cb.onAttemptEnd(record);
      return {
        ok: true,
        move: resolved.value.move,
        attempts,
        reasoning,
        commentary: extractCommentary(raw),
        usage: result.usage,
        warnings: resolved.value.warnings,
        exchange: {
          ply: movesOnBoard,
          // Replay exactly what this turn put on the wire, including any
          // rejected reply + correction prompt, so the next turn continues the
          // same conversation instead of silently dropping the retries.
          messages: [...turnMessages, { role: 'assistant', content: raw || resolved.value.move.san }],
        },
      };
    }

    const record: AttemptRecord = {
      index: index + 1,
      reasoning,
      text,
      raw,
      error: resolved.reason,
      elapsedMs,
      usage: result.usage,
      status: result.status,
      notice: null,
    };
    attempts.push(record);
    cb.onAttemptEnd(record);
    const rejected = raw.slice(0, 4000);
    const correction = buildCorrectionPrompt(resolved.reason, raw, opts.chess);
    messages.push({ role: 'assistant', content: rejected });
    messages.push({ role: 'user', content: correction });
    turnMessages.push({ role: 'assistant', content: rejected });
    turnMessages.push({ role: 'user', content: correction });
    if (index + 1 < limit) {
      cb.onNotice(`着法不合法或格式错误，正在让模型重新选择（第 ${index + 1}/${limit} 次）…`);
    }
  }

  return {
    ok: false,
    error: attempts.at(-1)?.error ?? 'AI 未能给出合法着法',
    attempts,
  };
}
