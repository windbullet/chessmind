import { Chess, type Move } from 'chess.js';
import { create } from 'zustand';
import { requestAiMove } from '../ai/coordinator';
import { appendExchange, truncateForPly } from '../ai/context';
import type { Exchange } from '../ai/context';
import type { AttemptRecord, Usage } from '../ai/types';
import {
  buildCoachReviewPrompt,
  buildCoachSummaryPrompt,
  buildCoachSystemPrompt,
  buildHintPrompt,
  buildHintSystemPrompt,
  buildSummarySystemPrompt,
  parseCoachReview,
  parseHint,
  parseSummary,
} from '../coach/prompt';
import { requestCoach } from '../coach/request';
import { DEFAULT_COACH } from '../coach/types';
import type { CoachConfig } from '../coach/types';
import { useSettings, coachProfileFor, profileFor } from '../settings';
import {
  buildChess,
  findLegalMove,
  gameResultOf,
  legalMoves,
  moveLogToSan,
  uciOf,
} from './engine';
import {
  castlingAvailable,
  cloneDraft,
  draftFromFen,
  draftToChess,
  draftToFen,
  emptyDraft,
  kingsOnlyDraft,
  moveDraftPiece,
  normalizeCastling,
  standardDraft,
  toggleSquarePiece,
  validateDraft,
} from './setup';
import type { DraftPiece, DraftValidation, SetupDraft } from './setup';
import type {
  Actor,
  Anchor,
  GameResult,
  GameSnapshot,
  Mode,
  MoveEntry,
  ResultReason,
  Side,
} from './types';
import { START_FEN } from './types';

let engine: Chess = new Chess(START_FEN);

/**
 * Conversation carried across moves for continuous-context mode: each AI turn's
 * position pack plus the reply it gave. Kept outside the Zustand state because
 * it never needs to trigger a re-render. Reset on a new game / board edit and
 * truncated when moves are taken back.
 *
 * Kept PER SIDE: in an AI-vs-AI game the two engines are separate conversations,
 * and showing White's reasoning to Black would both leak its plan and break the
 * prompt-cache prefix (a different profile = a different request anyway).
 */
let exchangesBySide: Record<Side, Exchange[]> = { w: [], b: [] };

function clearExchanges(): void {
  exchangesBySide = { w: [], b: [] };
}

/* ------------------------------------------------------------------- coach */

/**
 * One coach card about one position: the verdict on the move that was just
 * played (or the explanation the engine itself gave for it), the read of the
 * position, or the suggestion the user asked for.
 */
export interface CoachEntry {
  id: number;
  kind: 'review' | 'hint';
  /** Half-moves on the board when the job was queued; used to drop stale entries on undo. */
  ply: number;
  number: number;
  side: Side;
  /** The move under review, or the suggested move for a hint (null when unusable). */
  san: string | null;
  /** Verdict on the move (review), or the reason for the suggestion (hint). */
  verdict: string | null;
  /** Read of the position; review entries only. */
  read: string | null;
  error: string | null;
  elapsedMs: number;
  /** The request behind this card is still queued or in flight. */
  pending: boolean;
  /** Which paragraphs this card will end up having, so placeholders are honest. */
  expects: { verdict: boolean; read: boolean };
}

export interface CoachSummary {
  state: 'running' | 'done' | 'failed';
  text: string | null;
  error: string | null;
}

type CoachJob =
  | {
      kind: 'review';
      /** The card this job fills in; created when the request was queued. */
      entryId: number;
      afterFen: string;
      before: { fen: string; moves: string[] } | null;
      move: { number: number; side: Side; san: string };
      fields: { review: boolean; position: boolean };
    }
  | { kind: 'hint'; entryId: number; fen: string; side: Side; history: string }
  | { kind: 'summary'; sanLine: string; startFen: string; result: string };

/**
 * Coach work is a single queue drained one request at a time: it never joins the
 * move loop, so a slow coach can neither delay nor break an AI turn.
 */
let coachQueue: CoachJob[] = [];
let coachAbort: AbortController | null = null;
let coachToken = 0;
let coachEntrySeq = 0;
let coachDraining = false;
/** Kind of the job currently on the wire, so a hint can be cancelled alone. */
let coachRunning: CoachJob['kind'] | null = null;
/** The side the coach speaks to: the single human, or `null` when both sides are. */
function studentSideOf(players: { w: Actor; b: Actor }): Side | null {
  if (players.w === 'human' && players.b !== 'human') return 'w';
  if (players.b === 'human' && players.w !== 'human') return 'b';
  return null;
}


export function getEngine(): Chess {
  return engine;
}

let aiAbort: AbortController | null = null;
let aiToken = 0;
let aiTimer: ReturnType<typeof setTimeout> | null = null;
let toastSeq = 0;

export interface AiTurnView {
  id: number;
  side: Side;
  /** Saved AI profile used for this turn (name is for display). */
  profileName: string;
  attempt: number;
  limit: number;
  reasoning: string;
  text: string;
  notice: string | null;
  attempts: AttemptRecord[];
  error: string | null;
  commentary: string | null;
  usage: Usage | null;
  elapsedMs: number;
  phase: 'requesting' | 'done' | 'failed';
  startedAt: number;
}

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'error';
}

export type SetupSource = 'new' | 'midgame';

interface GameStore {
  mode: Mode;
  players: { w: Actor; b: Actor };
  orientation: Side;
  anchor: Anchor;
  fen: string;
  turn: Side;
  moveLog: MoveEntry[];
  lastMove: { from: string; to: string } | null;
  snapshots: GameSnapshot[];
  result: GameResult | null;
  thinking: boolean;
  aiTurn: AiTurnView | null;
  aiError: string | null;
  setupDraft: SetupDraft | null;
  setupValidation: DraftValidation | null;
  setupPast: SetupDraft[];
  setupFuture: SetupDraft[];
  setupReturn: GameSnapshot | null;
  /** Players/orientation/coach in effect before the setup editor opened. */
  setupReturnSides: {
    players: { w: Actor; b: Actor };
    orientation: Side;
    coach: CoachConfig;
  } | null;
  setupSource: SetupSource | null;
  toast: Toast | null;
  version: number;
  /** Increments only when a move is actually played, so the board can animate it. */
  moveSeq: number;
  /** Coach mode of the current game, chosen in the new-game dialog. */
  coach: CoachConfig;
  coachLog: CoachEntry[];
  /** A guidance request is queued or in flight. */
  hintBusy: boolean;
  coachSummary: CoachSummary | null;

  startGame(opts: {
    players: { w: Actor; b: Actor };
    fen?: string;
    orientation?: Side;
    coach?: CoachConfig;
  }): void;
  openSetup(opts: {
    source: SetupSource;
    blank?: boolean;
    fen?: string;
    /** Sides chosen in the new-game dialog; applied for the duration of the editor. */
    players?: { w: Actor; b: Actor };
    orientation?: Side;
    coach?: CoachConfig;
  }): void;
  setSetupPiece(square: string, piece: DraftPiece | null): void;
  moveSetupPiece(from: string, to: string): void;
  clearSetupBoard(): void;
  resetSetupStandard(): void;
  setupKingsOnly(): void;
  setSetupTurn(turn: Side): void;
  toggleSetupCastling(color: Side, side: 'k' | 'q'): void;
  setSetupCounters(halfmove: number, moveNumber: number): void;
  loadSetupFen(fen: string): boolean;
  setupUndo(): void;
  setupRedo(): void;
  applySetup(): boolean;
  cancelSetup(): void;
  humanMove(from: string, to: string, promotion?: string): boolean;
  undo(): void;
  flip(): void;
  togglePause(): void;
  finishGame(reason: ResultReason): void;
  /** Ask the coach for one suggested move in the current position. */
  askHint(): void;
  retryAi(): void;
  playRandomMove(): void;
  abortAi(): void;
  notify(message: string, tone?: Toast['tone']): void;
  clearToast(): void;
}

function snapshotOf(state: {
  anchor: Anchor;
  moveLog: MoveEntry[];
  lastMove: { from: string; to: string } | null;
  mode: Mode;
  result: GameResult | null;
  turn: Side;
}): GameSnapshot {
  return {
    anchor: state.anchor,
    moveLog: state.moveLog,
    lastMove: state.lastMove,
    mode: state.mode,
    result: state.result,
    turn: state.turn,
  };
}

function makeToast(message: string, tone: Toast['tone']): Toast {
  toastSeq += 1;
  return { id: toastSeq, message, tone };
}

function cancelPendingAi(): void {
  if (aiTimer) {
    clearTimeout(aiTimer);
    aiTimer = null;
  }
  if (aiAbort) {
    aiAbort.abort();
    aiAbort = null;
  }
  aiToken += 1;
}

export const useGame = create<GameStore>((set, get) => {
  const initialSnapshot: GameSnapshot = {
    anchor: { fen: START_FEN, logIndex: 0 },
    moveLog: [],
    lastMove: null,
    mode: 'idle',
    result: null,
    turn: 'w',
  };

  function commitSnapshot(snapshot: GameSnapshot, extra: Partial<GameStore> = {}): void {
    const state = get();
    set({
      mode: snapshot.mode,
      anchor: snapshot.anchor,
      moveLog: snapshot.moveLog,
      lastMove: snapshot.lastMove,
      result: snapshot.result,
      turn: snapshot.turn,
      fen: engine.fen(),
      snapshots: [...state.snapshots, snapshot],
      version: state.version + 1,
      ...extra,
    });
  }

  /* ------------------------------------------------------------- coach work */

  function pushCoachEntry(entry: Omit<CoachEntry, 'id'>): number {
    coachEntrySeq += 1;
    const id = coachEntrySeq;
    set((state) => ({ coachLog: [...state.coachLog, { ...entry, id }].slice(-60) }));
    return id;
  }

  function patchCoachEntry(id: number, patch: Partial<CoachEntry>): void {
    set((state) => ({
      coachLog: state.coachLog.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    }));
  }

  /** Drop cards whose request was cancelled, so nothing spins forever. */
  function dropPendingEntries(): void {
    set((state) => ({ coachLog: state.coachLog.filter((entry) => !entry.pending) }));
  }

  function syncHintBusy(): void {
    const busy = coachRunning === 'hint' || coachQueue.some((job) => job.kind === 'hint');
    if (get().hintBusy !== busy) set({ hintBusy: busy });
  }

  /** Drop every queued or running coach request (new game, setup, pause, undo). */
  function cancelPendingCoach(): void {
    coachQueue = [];
    if (coachAbort) {
      coachAbort.abort();
      coachAbort = null;
    }
    coachToken += 1;
    syncHintBusy();
    dropPendingEntries();
    if (get().coachSummary?.state === 'running') set({ coachSummary: null });
  }

  /** A move landed, so any pending suggestion is about a position that is gone. */
  function dropPendingHints(): void {
    coachQueue = coachQueue.filter((job) => job.kind !== 'hint');
    if (coachRunning === 'hint') {
      coachAbort?.abort();
      coachAbort = null;
      coachToken += 1;
    }
    syncHintBusy();
    set((state) => ({
      coachLog: state.coachLog.filter((entry) => !(entry.pending && entry.kind === 'hint')),
    }));
  }

  function queueCoach(job: CoachJob, front = false): void {
    if (!get().coach.enabled) return;
    if (front) coachQueue.unshift(job);
    else coachQueue.push(job);
    syncHintBusy();
    void pumpCoach();
  }

  async function pumpCoach(): Promise<void> {
    if (coachDraining) return;
    coachDraining = true;
    try {
      for (;;) {
        const job = coachQueue.shift();
        if (!job) break;
        if (!get().coach.enabled) continue;
        try {
          await runCoachJob(job);
        } catch (error) {
          // A coach failure must never escape as an unhandled rejection: the
          // game has no reason to care about it.
          console.warn('coach request failed', error);
        }
      }
    } finally {
      coachDraining = false;
      coachRunning = null;
      syncHintBusy();
    }
  }

  async function runCoachJob(job: CoachJob): Promise<void> {
    const settings = useSettings.getState().settings;
    const profile = coachProfileFor(settings, get().players);
    const lang = settings.ui.commentaryLang;
    const studentSide = studentSideOf(get().players);
    const controller = new AbortController();
    coachAbort = controller;
    coachRunning = job.kind;
    const token = (coachToken += 1);
    const isCurrent = () => token === coachToken && !controller.signal.aborted;
    syncHintBusy();
    if (job.kind === 'summary') {
      set({ coachSummary: { state: 'running', text: null, error: null } });
    }

    try {
      let system = '';
      let user = '';
      if (job.kind === 'review') {
        system = buildCoachSystemPrompt({ studentSide, lang, fields: job.fields });
        user = buildCoachReviewPrompt({
          // The legal-move list of the previous position is only needed when the
          // coach has to name a better move.
          before: job.fields.review ? job.before : null,
          move: job.move,
          after: new Chess(job.afterFen, { skipValidation: true }),
        });
      } else if (job.kind === 'hint') {
        const chess = new Chess(job.fen, { skipValidation: true });
        system = buildHintSystemPrompt({ side: job.side, lang });
        user = buildHintPrompt({ chess, side: job.side, history: job.history });
      } else {
        system = buildSummarySystemPrompt({ studentSide, lang });
        user = buildCoachSummaryPrompt({
          startFen: job.startFen,
          sanLine: job.sanLine,
          result: job.result,
          lang,
        });
      }

      const reply = await requestCoach({
        cfg: profile.config,
        system,
        user,
        signal: controller.signal,
      });
      if (!isCurrent()) return;

      if (job.kind === 'summary') {
        set({
          coachSummary: reply.ok
            ? { state: 'done', text: parseSummary(reply.text), error: null }
            : { state: 'failed', text: null, error: reply.error ?? '教练请求失败' },
        });
        return;
      }

      if (job.kind === 'hint') {
        const hint = reply.ok
          ? parseHint(reply.text, new Chess(job.fen, { skipValidation: true }))
          : { san: null, why: '' };
        patchCoachEntry(job.entryId, {
          san: reply.ok ? hint.san : null,
          verdict: reply.ok ? hint.why || null : null,
          error: reply.ok ? null : (reply.error ?? '教练请求失败'),
          elapsedMs: reply.elapsedMs,
          pending: false,
        });
        return;
      }

      const parsed = reply.ok
        ? parseCoachReview(reply.text, job.fields)
        : { moveReview: null, positionRead: null };
      const patch: Partial<CoachEntry> = {
        error: reply.ok ? null : (reply.error ?? '教练请求失败'),
        elapsedMs: reply.elapsedMs,
        pending: false,
      };
      // Only overwrite what this request actually asked for: the engine's own
      // explanation of its move is already on the card and must survive.
      if (job.fields.review) patch.verdict = parsed.moveReview;
      if (job.fields.position) patch.read = parsed.positionRead;
      patchCoachEntry(job.entryId, patch);
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      if (job.kind === 'summary') {
        set({ coachSummary: { state: 'failed', text: null, error: message } });
      } else {
        patchCoachEntry(job.entryId, { error: message, pending: false });
      }
    } finally {
      if (coachAbort === controller) coachAbort = null;
      coachRunning = null;
      syncHintBusy();
    }
  }

  function applyMove(
    from: string,
    to: string,
    promotion: string | undefined,
    actor: Actor,
    /** The engine's own explanation of this move, when it was asked for one. */
    ownCommentary: string | null = null,
  ): boolean {
    const state = get();
    const move = findLegalMove(engine, { from, to, promotion });
    if (!move) return false;
    const coach = state.coach;
    // Only a human move no engine explained itself is critiqued, and only that
    // case needs the position the move was played in (and its legal moves).
    const judgeMove = coach.enabled && actor === 'human' && coach.opponentMoves;
    const beforeFen = judgeMove ? engine.fen() : '';
    const beforeMoves = judgeMove ? legalMoves(engine).map((item) => item.san) : [];
    const number = engine.moveNumber();
    const applied = engine.move({ from: move.from, to: move.to, promotion: move.promotion });
    if (!applied) return false;
    const entry: MoveEntry = {
      ply: state.moveLog.length,
      number,
      color: applied.color,
      san: applied.san,
      uci: uciOf(applied),
      actor,
    };
    const moveLog = [...state.moveLog, entry];
    const result = gameResultOf(engine);
    commitSnapshot({
      anchor: state.anchor,
      moveLog,
      lastMove: { from: applied.from, to: applied.to },
      mode: result ? 'finished' : 'playing',
      result,
      turn: engine.turn(),
    });
    set({ moveSeq: state.moveSeq + 1 });

    // A suggestion is about the position that just went away.
    dropPendingHints();
    if (coach.enabled) {
      if (actor === 'human') {
        const review = coach.opponentMoves;
        if (review || coach.position) {
          const entryId = pushCoachEntry({
            kind: 'review',
            ply: moveLog.length,
            number,
            side: applied.color,
            san: applied.san,
            verdict: null,
            read: null,
            error: null,
            elapsedMs: 0,
            pending: true,
            expects: { verdict: review, read: coach.position },
          });
          queueCoach({
            kind: 'review',
            entryId,
            before: review ? { fen: beforeFen, moves: beforeMoves } : null,
            afterFen: engine.fen(),
            move: { number, side: applied.color, san: applied.san },
            fields: { review, position: coach.position },
          });
        }
      } else if (coach.ownMoves || coach.position) {
        // The engine narrates its own move (that text rides along with the move
        // request), so the coach only adds a read of the resulting position.
        const entryId = pushCoachEntry({
          kind: 'review',
          ply: moveLog.length,
          number,
          side: applied.color,
          san: applied.san,
          verdict: coach.ownMoves ? ownCommentary : null,
          read: null,
          error: null,
          elapsedMs: 0,
          pending: coach.position,
          expects: { verdict: coach.ownMoves, read: coach.position },
        });
        if (coach.position) {
          queueCoach({
            kind: 'review',
            entryId,
            before: null,
            afterFen: engine.fen(),
            move: { number, side: applied.color, san: applied.san },
            fields: { review: false, position: true },
          });
        }
      }
    }
    if (result && coach.enabled && coach.summary) {
      queueCoach({
        kind: 'summary',
        startFen: state.anchor.fen,
        sanLine: moveLogToSan(moveLog, state.anchor.logIndex),
        result: result.text,
      });
    }
    return true;
  }

  function scheduleAi(): void {
    const state = get();
    if (state.mode !== 'playing') return;
    if (state.players[state.turn] !== 'ai') return;
    if (aiTimer) clearTimeout(aiTimer);
    aiTimer = setTimeout(() => {
      aiTimer = null;
      void runAiTurn();
    }, 420);
  }

  async function runAiTurn(): Promise<void> {
    const state = get();
    if (state.mode !== 'playing' || state.players[state.turn] !== 'ai') return;
    const settings = useSettings.getState().settings;
    const controller = new AbortController();
    aiAbort = controller;
    const token = (aiToken += 1);
    const side = state.turn;
    const chess = engine;
    // Each side can use a different saved AI profile (relevant for AI vs AI).
    const profile = profileFor(settings, side);
    const cfg = profile.config;
    const history = state.moveLog
      .slice(state.anchor.logIndex)
      .filter((entry) => entry.actor !== 'edit')
      .map((entry) => entry.san);
    const edited = state.anchor.logIndex > 0;

    set({
      thinking: true,
      aiError: null,
      aiTurn: {
        id: token,
        side,
        profileName: profile.name,
        attempt: 1,
        limit: cfg.retries,
        reasoning: '',
        text: '',
        notice: null,
        attempts: [],
        error: null,
        commentary: null,
        usage: null,
        elapsedMs: 0,
        phase: 'requesting',
        startedAt: Date.now(),
      },
    });

    const isCurrent = () => token === aiToken && !controller.signal.aborted;

    try {
      const outcome = await requestAiMove(
        {
          cfg,
          side,
          chess,
          history,
          edited,
          commentary: state.coach.enabled && state.coach.ownMoves,
          lang: settings.ui.commentaryLang,
          opponent: state.players[side === 'w' ? 'b' : 'w'] === 'ai' ? 'ai' : 'human',
          exchanges: exchangesBySide[side],
          signal: controller.signal,
        },
        {
          onAttemptStart: (attempt, limit) => {
            if (!isCurrent()) return;
            const turn = get().aiTurn;
            if (!turn) return;
            set({
              aiTurn: {
                ...turn,
                attempt,
                limit,
                reasoning: '',
                text: '',
                notice: null,
                error: null,
              },
            });
          },
          onReasoning: (chunk) => {
            if (!isCurrent()) return;
            const turn = get().aiTurn;
            if (!turn) return;
            set({ aiTurn: { ...turn, reasoning: turn.reasoning + chunk } });
          },
          onText: (chunk) => {
            if (!isCurrent()) return;
            const turn = get().aiTurn;
            if (!turn) return;
            set({ aiTurn: { ...turn, text: turn.text + chunk } });
          },
          onAttemptEnd: (record) => {
            if (!isCurrent()) return;
            const turn = get().aiTurn;
            if (!turn) return;
            set({ aiTurn: { ...turn, attempts: [...turn.attempts, record] } });
          },
          onNotice: (message) => {
            if (!isCurrent()) return;
            const turn = get().aiTurn;
            if (!turn) return;
            set({ aiTurn: { ...turn, notice: message } });
          },
        },
      );

      if (!isCurrent()) return;

      if (!outcome.ok) {
        const turn = get().aiTurn;
        set({
          thinking: false,
          aiError: outcome.error,
          aiTurn: turn
            ? { ...turn, phase: 'failed', error: outcome.error, elapsedMs: Date.now() - turn.startedAt }
            : null,
          mode: get().mode === 'playing' ? 'paused' : get().mode,
        });
        return;
      }

      const current = get();
      if (current.mode !== 'playing' || current.turn !== side) return;
      const turn = get().aiTurn;
      set({
        thinking: false,
        aiTurn: turn
          ? {
              ...turn,
              phase: 'done',
              reasoning: outcome.reasoning || turn.reasoning,
              commentary: outcome.commentary,
              usage: outcome.usage,
              elapsedMs: Date.now() - turn.startedAt,
              error: null,
            }
          : null,
      });
      applyMove(outcome.move.from, outcome.move.to, outcome.move.promotion, 'ai', outcome.commentary);
      exchangesBySide[side] = appendExchange(
        exchangesBySide[side],
        outcome.exchange,
        cfg.contextBudget,
      );
      if (outcome.warnings.length > 0) {
        get().notify(outcome.warnings.join('；'), 'info');
      }
      scheduleAi();
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      const turn = get().aiTurn;
      set({
        thinking: false,
        aiError: message,
        aiTurn: turn ? { ...turn, phase: 'failed', error: message } : null,
        mode: get().mode === 'playing' ? 'paused' : get().mode,
      });
    } finally {
      if (aiAbort === controller) aiAbort = null;
    }
  }

  function abortAiInternal(): void {
    cancelPendingAi();
    const state = get();
    if (!state.thinking) return;
    const turn = state.aiTurn;
    set({
      thinking: false,
      aiTurn: turn
        ? { ...turn, phase: 'failed', error: turn.error ?? '已中断', elapsedMs: Date.now() - turn.startedAt }
        : null,
    });
  }

  function findUndoTarget(snapshots: GameSnapshot[], players: { w: Actor; b: Actor }): number | null {
    const hasHuman = players.w === 'human' || players.b === 'human';
    for (let i = snapshots.length - 2; i >= 0; i -= 1) {
      const snapshot = snapshots[i];
      if (snapshot.mode === 'setup') continue;
      if (!hasHuman) return i;
      if (players[snapshot.turn] === 'human') return i;
    }
    return null;
  }

  function pushSetup(next: SetupDraft): void {
    const state = get();
    // Editing the board can strand castling rights (king or rook moved); drop
    // them here so the draft never claims a right the position cannot honour.
    const normalized = normalizeCastling(next);
    set({
      setupDraft: normalized,
      setupPast: [...state.setupPast, state.setupDraft ?? normalized].slice(-120),
      setupFuture: [],
      setupValidation: validateDraft(cloneDraft(normalized)),
    });
  }

  return {
    mode: 'idle',
    players: { w: 'human', b: 'ai' },
    orientation: 'w',
    anchor: { fen: START_FEN, logIndex: 0 },
    fen: START_FEN,
    turn: 'w',
    moveLog: [],
    lastMove: null,
    snapshots: [initialSnapshot],
    result: null,
    thinking: false,
    aiTurn: null,
    aiError: null,
    setupDraft: null,
    setupValidation: null,
    setupPast: [],
    setupFuture: [],
    setupReturn: null,
    setupReturnSides: null,
    setupSource: null,
    toast: null,
    version: 0,
    moveSeq: 0,
    coach: { ...DEFAULT_COACH },
    coachLog: [],
    hintBusy: false,
    coachSummary: null,

    startGame({ players, fen, orientation, coach }) {
      abortAiInternal();
      clearExchanges();
      cancelPendingCoach();
      const nextCoach: CoachConfig = { ...(coach ?? get().coach) };
      const startFen = fen ?? START_FEN;
      engine = new Chess(startFen, { skipValidation: true });
      const anchor: Anchor = { fen: startFen, logIndex: 0 };
      const result = gameResultOf(engine);
      const snapshot: GameSnapshot = {
        anchor,
        moveLog: [],
        lastMove: null,
        mode: result ? 'finished' : 'playing',
        result,
        turn: engine.turn(),
      };
      set({
        mode: snapshot.mode,
        players,
        orientation: orientation ?? get().orientation,
        coach: nextCoach,
        coachLog: [],
        coachSummary: null,
        hintBusy: false,
        anchor,
        moveLog: [],
        lastMove: null,
        snapshots: [snapshot],
        result,
        thinking: false,
        aiTurn: null,
        aiError: null,
        setupDraft: null,
        setupValidation: null,
        setupPast: [],
        setupFuture: [],
        setupReturn: null,
        setupReturnSides: null,
        setupSource: null,
        fen: engine.fen(),
        turn: engine.turn(),
        version: get().version + 1,
      });
      useSettings.getState().update({
        players,
        orientation: orientation ?? get().orientation,
        coach: nextCoach,
      });
      scheduleAi();
    },

    openSetup({ source, blank, fen, players: nextPlayers, orientation: nextOrientation, coach }) {
      abortAiInternal();
      cancelPendingCoach();
      const state = get();
      let draft: SetupDraft;
      if (source === 'new') {
        draft = blank ? emptyDraft('w') : fen ? draftFromFen(fen) : standardDraft();
      } else {
        draft = draftFromFen(engine.fen());
      }
      // Always remember the live game so "取消" can restore it, whatever the entry point.
      const hasLiveGame =
        state.mode === 'playing' || state.mode === 'paused' || state.mode === 'finished';
      const returnSnapshot = hasLiveGame
        ? snapshotOf({
            anchor: state.anchor,
            moveLog: state.moveLog,
            lastMove: state.lastMove,
            mode: state.mode,
            result: state.result,
            turn: state.turn,
          })
        : state.setupReturn;
      set({
        mode: 'setup',
        players: nextPlayers ?? state.players,
        orientation: nextOrientation ?? state.orientation,
        coach: coach ? { ...coach } : state.coach,
        setupDraft: draft,
        setupValidation: validateDraft(cloneDraft(draft)),
        setupPast: [],
        setupFuture: [],
        setupReturn: returnSnapshot,
        setupReturnSides: {
          players: state.players,
          orientation: state.orientation,
          coach: state.coach,
        },
        setupSource: source,
        thinking: false,
        aiTurn: null,
        aiError: null,
      });
    },

    setSetupPiece(square, piece) {
      const draft = get().setupDraft;
      if (!draft) return;
      const next = toggleSquarePiece(draft, square, piece);
      pushSetup(next);
    },

    moveSetupPiece(from, to) {
      const draft = get().setupDraft;
      if (!draft) return;
      pushSetup(moveDraftPiece(draft, from, to));
    },

    clearSetupBoard() {
      const draft = get().setupDraft;
      if (!draft) return;
      pushSetup(emptyDraft(draft.turn));
    },

    resetSetupStandard() {
      pushSetup(standardDraft());
    },

    setupKingsOnly() {
      const draft = get().setupDraft;
      if (!draft) return;
      pushSetup(kingsOnlyDraft(draft.turn));
    },

    setSetupTurn(turn) {
      const draft = get().setupDraft;
      if (!draft) return;
      pushSetup({ ...cloneDraft(draft), turn });
    },

    toggleSetupCastling(color, side) {
      const draft = get().setupDraft;
      if (!draft) return;
      if (!castlingAvailable(draft, color, side)) {
        get().notify('易位权要求王与车在初始格', 'error');
        return;
      }
      const next = cloneDraft(draft);
      next.castling[color][side] = !next.castling[color][side];
      pushSetup(next);
    },

    setSetupCounters(halfmove, moveNumber) {
      const draft = get().setupDraft;
      if (!draft) return;
      const next = cloneDraft(draft);
      next.halfmove = Math.max(0, Math.floor(halfmove));
      next.moveNumber = Math.max(1, Math.floor(moveNumber));
      pushSetup(next);
    },

    loadSetupFen(fen) {
      try {
        // Validate the structural FEN first so the user gets a precise message.
        const probe = new Chess();
        probe.load(fen, { skipValidation: false });
        const draft = draftFromFen(fen);
        pushSetup(draft);
        get().notify('已载入 FEN', 'success');
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        get().notify(`FEN 无法解析：${message}`, 'error');
        return false;
      }
    },

    setupUndo() {
      const state = get();
      if (state.setupPast.length === 0 || !state.setupDraft) return;
      const previous = state.setupPast[state.setupPast.length - 1];
      set({
        setupDraft: previous,
        setupPast: state.setupPast.slice(0, -1),
        setupFuture: [state.setupDraft, ...state.setupFuture],
        setupValidation: validateDraft(cloneDraft(previous)),
      });
    },

    setupRedo() {
      const state = get();
      if (state.setupFuture.length === 0 || !state.setupDraft) return;
      const next = state.setupFuture[0];
      set({
        setupDraft: next,
        setupPast: [...state.setupPast, state.setupDraft],
        setupFuture: state.setupFuture.slice(1),
        setupValidation: validateDraft(cloneDraft(next)),
      });
    },

    applySetup() {
      const state = get();
      const draft = state.setupDraft;
      if (!draft) return false;
      const validation = validateDraft(cloneDraft(draft));
      if (!validation.ok) {
        set({ setupValidation: validation });
        get().notify(validation.errors[0] ?? '局面不合法', 'error');
        return false;
      }
      abortAiInternal();
      // The board was rearranged, so every remembered position pack is stale.
      clearExchanges();
      cancelPendingCoach();
      const fen = draftToFen(draft);
      const chess = draftToChess(draft);
      const result = gameResultOf(chess);
      const isMidgame = state.setupSource === 'midgame' && state.setupReturn !== null;
      const moveLog: MoveEntry[] = isMidgame
        ? [
            ...state.moveLog,
            {
              ply: state.moveLog.length,
              number: Math.max(1, Math.floor(draft.moveNumber)),
              color: chess.turn(),
              san: '—',
              uci: '',
              actor: 'edit',
            },
          ]
        : [];
      const anchor: Anchor = { fen, logIndex: moveLog.length };
      engine = chess;
      const snapshot: GameSnapshot = {
        anchor,
        moveLog,
        lastMove: null,
        mode: result ? 'finished' : 'playing',
        result,
        turn: engine.turn(),
      };
      set({
        mode: snapshot.mode,
        anchor,
        moveLog,
        lastMove: null,
        result,
        coachLog: [],
        coachSummary: null,
        snapshots: isMidgame ? [...state.snapshots, snapshot] : [snapshot],
        setupDraft: null,
        setupValidation: null,
        setupPast: [],
        setupFuture: [],
        setupReturn: null,
        setupReturnSides: null,
        setupSource: null,
        thinking: false,
        aiTurn: null,
        aiError: null,
        fen: engine.fen(),
        turn: engine.turn(),
        version: state.version + 1,
      });
      get().notify(isMidgame ? '已按新摆放继续对局' : '已按新摆放开始对局', 'success');
      scheduleAi();
      return true;
    },

    cancelSetup() {
      const state = get();
      const back = state.setupReturn;
      if (!back) {
        engine = new Chess(START_FEN, { skipValidation: true });
        clearExchanges();
        set({
          mode: 'idle',
          players: state.setupReturnSides?.players ?? state.players,
          orientation: state.setupReturnSides?.orientation ?? state.orientation,
          coach: state.setupReturnSides?.coach ?? state.coach,
          anchor: { fen: START_FEN, logIndex: 0 },
          moveLog: [],
          lastMove: null,
          result: null,
          snapshots: [
            {
              anchor: { fen: START_FEN, logIndex: 0 },
              moveLog: [],
              lastMove: null,
              mode: 'idle',
              result: null,
              turn: 'w',
            },
          ],
          setupDraft: null,
          setupValidation: null,
          setupPast: [],
          setupFuture: [],
          setupReturn: null,
          setupReturnSides: null,
          setupSource: null,
          fen: START_FEN,
          turn: 'w',
          version: state.version + 1,
        });
        return;
      }
      engine = buildChess(back.anchor, back.moveLog);
      set({
        mode: back.mode,
        players: state.setupReturnSides?.players ?? state.players,
        orientation: state.setupReturnSides?.orientation ?? state.orientation,
        coach: state.setupReturnSides?.coach ?? state.coach,
        anchor: back.anchor,
        moveLog: back.moveLog,
        lastMove: back.lastMove,
        result: back.result,
        setupDraft: null,
        setupValidation: null,
        setupPast: [],
        setupFuture: [],
        setupReturn: null,
        setupReturnSides: null,
        setupSource: null,
        fen: engine.fen(),
        turn: engine.turn(),
        version: state.version + 1,
      });
      scheduleAi();
    },

    humanMove(from, to, promotion) {
      const state = get();
      if (state.mode !== 'playing') return false;
      if (state.players[state.turn] !== 'human') return false;
      if (state.thinking) return false;
      const ok = applyMove(from, to, promotion, 'human');
      if (ok) scheduleAi();
      return ok;
    },

    undo() {
      abortAiInternal();
      const state = get();
      if (state.mode === 'setup') return;
      const target = findUndoTarget(state.snapshots, state.players);
      if (target === null) {
        get().notify('没有可以悔棋的着法', 'info');
        return;
      }
      const snapshot = state.snapshots[target];
      engine = buildChess(snapshot.anchor, snapshot.moveLog);
      // Same count as the `history` array fed to the AI: committed moves after
      // the anchor, excluding arbiter edits. Exchanges with a larger ply were
      // about positions that no longer exist, so drop them (and their plans).
      const playedMoves = snapshot.moveLog
        .slice(snapshot.anchor.logIndex)
        .filter((entry) => entry.actor !== 'edit').length;
      exchangesBySide = {
        w: truncateForPly(exchangesBySide.w, playedMoves),
        b: truncateForPly(exchangesBySide.b, playedMoves),
      };
      // Coach remarks about positions that no longer exist go too.
      cancelPendingCoach();
      set({
        mode: snapshot.mode === 'finished' ? 'playing' : snapshot.mode,
        anchor: snapshot.anchor,
        moveLog: snapshot.moveLog,
        lastMove: snapshot.lastMove,
        result: snapshot.mode === 'finished' ? null : snapshot.result,
        snapshots: state.snapshots.slice(0, target + 1),
        coachLog: state.coachLog.filter((entry) => entry.ply <= playedMoves),
        coachSummary: null,
        thinking: false,
        aiTurn: null,
        aiError: null,
        fen: engine.fen(),
        turn: engine.turn(),
        version: state.version + 1,
      });
      scheduleAi();
    },

    flip() {
      const orientation: Side = get().orientation === 'w' ? 'b' : 'w';
      set({ orientation });
      useSettings.getState().update({ orientation });
    },

    togglePause() {
      const state = get();
      if (state.mode === 'playing') {
        abortAiInternal();
        // Nothing should be hitting the network while the game is paused.
        cancelPendingCoach();
        set({ mode: 'paused', thinking: false, version: state.version + 1 });
      } else if (state.mode === 'paused') {
        set({ mode: 'playing', aiError: null, version: state.version + 1 });
        scheduleAi();
      }
    },

    finishGame(reason) {
      abortAiInternal();
      cancelPendingCoach();
      const state = get();
      if (state.mode === 'idle' || state.mode === 'setup') return;
      if (state.mode === 'finished') return;
      // "resigned" is the UI's "结束对局": the side that ended it concedes.
      const winner: Side | null = reason === 'resigned' ? (state.turn === 'w' ? 'b' : 'w') : null;
      const result: GameResult = {
        winner,
        reason,
        text: reason === 'resigned' ? '对局已手动结束' : '对局已结束',
      };
      commitSnapshot({
        anchor: state.anchor,
        moveLog: state.moveLog,
        lastMove: state.lastMove,
        mode: 'finished',
        result,
        turn: state.turn,
      });
      set({ thinking: false, aiTurn: null, aiError: null });
    },

    askHint() {
      const state = get();
      if (!state.coach.enabled || !state.coach.hint) return;
      if (state.mode !== 'playing' || state.thinking) return;
      if (state.players[state.turn] !== 'human') return;
      const ply = state.moveLog.filter((entry) => entry.actor !== 'edit').length;
      // Asking again replaces the previous suggestion for the same position.
      set({ coachLog: state.coachLog.filter((e) => !(e.kind === 'hint' && e.ply === ply)) });
      const number = engine.moveNumber();
      const entryId = pushCoachEntry({
        kind: 'hint',
        ply,
        number,
        side: state.turn,
        san: null,
        verdict: null,
        read: null,
        error: null,
        elapsedMs: 0,
        pending: true,
        expects: { verdict: true, read: false },
      });
      queueCoach(
        {
          kind: 'hint',
          entryId,
          fen: engine.fen(),
          side: state.turn,
          history: moveLogToSan(state.moveLog, state.anchor.logIndex),
        },
        true,
      );
    },

    retryAi() {
      const state = get();
      if (state.mode === 'setup') return;
      set({ mode: 'playing', aiError: null, thinking: false, version: state.version + 1 });
      scheduleAi();
    },

    playRandomMove() {
      const state = get();
      // Offered in the AI panel when a request failed and the game is paused,
      // so it must accept both the normal and the paused state.
      if (state.mode !== 'playing' && state.mode !== 'paused') return;
      if (state.thinking) return;
      if (state.players[state.turn] !== 'ai') return;
      const moves = engine.moves({ verbose: true }) as Move[];
      if (moves.length === 0) return;
      const move = moves[Math.floor(Math.random() * moves.length)];
      if (state.mode === 'paused') set({ mode: 'playing', aiError: null, version: state.version + 1 });
      applyMove(move.from, move.to, move.promotion, 'ai');
      get().notify('已替 AI 随机走一手（用于继续对局）', 'info');
      scheduleAi();
    },

    abortAi() {
      abortAiInternal();
      set({ thinking: false });
    },

    notify(message, tone = 'info') {
      set({ toast: makeToast(message, tone) });
    },

    clearToast() {
      set({ toast: null });
    },
  };
});
