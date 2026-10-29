import type { Chess, PieceSymbol } from 'chess.js';

export const PIECE_VALUES: Record<PieceSymbol, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

export const PIECE_NAMES: Record<PieceSymbol, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};

export interface MaterialSummary {
  w: number;
  b: number;
  diff: number;
  pieces: { w: Record<string, number>; b: Record<string, number> };
}

export function materialOf(chess: Chess): MaterialSummary {
  const summary: MaterialSummary = {
    w: 0,
    b: 0,
    diff: 0,
    pieces: { w: {}, b: {} },
  };
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell) continue;
      const value = PIECE_VALUES[cell.type];
      summary[cell.color] += value;
      const bucket = summary.pieces[cell.color];
      bucket[cell.type] = (bucket[cell.type] ?? 0) + 1;
    }
  }
  summary.diff = summary.w - summary.b;
  return summary;
}
