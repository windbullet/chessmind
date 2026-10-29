import { Chess, type Move } from 'chess.js';
import { create } from 'zustand';
import { requestAiMove } from '../ai/coordinator';
import { appendExchange, truncateForPly } from '../ai/context';
import type { Exchange } from '../ai/context';
import type { AttemptRecord, Usage } from '../ai/types';
import { useSettings, profileFor } from '../settings';
import { buildChess, findLegalMove, gameResultOf, uciOf } from './engine';
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
  /** Players/orientation in effect before the setup editor opened. */
  setupReturnSides: { players: { w: Actor; b: Actor }; orientation: Side } | null;
  setupSource: SetupSource | null;
  toast: Toast | null;
  version: number;
  /** Increments only when a move is actually played, so the board can animate it. */
  moveSeq: number;

  startGame(opts: {
    players: { w: Actor; b: Actor };
    fen?: string;
    orientation?: Side;
  }): void;
  openSetup(opts: {
    source: SetupSource;
    blank?: boolean;
    fen?: string;
    /** Sides chosen in the new-game dialog; applied for the duration of the editor. */
    players?: { w: Actor; b: Actor };
    orientation?: Side;
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

  function applyMove(from: string, to: string, promotion: string | undefined, actor: Actor): boolean {
    const state = get();
    const move = findLegalMove(engine, { from, to, promotion });
    if (!move) return false;
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
          commentary: settings.ui.commentaryEnabled,
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
      applyMove(outcome.move.from, outcome.move.to, outcome.move.promotion, 'ai');
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

    startGame({ players, fen, orientation }) {
      abortAiInternal();
      clearExchanges();
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
      useSettings.getState().update({ players, orientation: orientation ?? get().orientation });
      scheduleAi();
    },

    openSetup({ source, blank, fen, players: nextPlayers, orientation: nextOrientation }) {
      abortAiInternal();
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
        setupDraft: draft,
        setupValidation: validateDraft(cloneDraft(draft)),
        setupPast: [],
        setupFuture: [],
        setupReturn: returnSnapshot,
        setupReturnSides: { players: state.players, orientation: state.orientation },
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
      set({
        mode: snapshot.mode === 'finished' ? 'playing' : snapshot.mode,
        anchor: snapshot.anchor,
        moveLog: snapshot.moveLog,
        lastMove: snapshot.lastMove,
        result: snapshot.mode === 'finished' ? null : snapshot.result,
        snapshots: state.snapshots.slice(0, target + 1),
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
        set({ mode: 'paused', thinking: false, version: state.version + 1 });
      } else if (state.mode === 'paused') {
        set({ mode: 'playing', aiError: null, version: state.version + 1 });
        scheduleAi();
      }
    },

    finishGame(reason) {
      abortAiInternal();
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
