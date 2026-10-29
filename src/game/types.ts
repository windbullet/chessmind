import type { Color } from 'chess.js';

export type Side = Color;
export type Actor = 'human' | 'ai';
export type Mode = 'idle' | 'playing' | 'paused' | 'finished' | 'setup';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** One played move (or an "edit" marker that splits the notation list). */
export interface MoveEntry {
  ply: number;
  number: number;
  color: Side;
  san: string;
  uci: string;
  actor: Actor | 'edit';
}

/** A position the current game is replayed from. */
export interface Anchor {
  fen: string;
  logIndex: number;
}

export type ResultReason =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient'
  | 'threefold'
  | 'fifty'
  | 'resigned';

export interface GameResult {
  winner: Side | null;
  reason: ResultReason;
  text: string;
}

export interface GameSnapshot {
  anchor: Anchor;
  moveLog: MoveEntry[];
  lastMove: { from: string; to: string } | null;
  mode: Mode;
  result: GameResult | null;
  turn: Side;
}

export interface SquareRef {
  from: string;
  to: string;
  promotion?: string;
}

export type { Color };
