import type { PieceSymbol } from 'chess.js';

/** Palette order: king, queen, rook, bishop, knight, pawn. */
export const PIECE_TYPES: PieceSymbol[] = ['k', 'q', 'r', 'b', 'n', 'p'];

export const PIECE_LABELS: Record<PieceSymbol, string> = {
  k: '王',
  q: '后',
  r: '车',
  b: '象',
  n: '马',
  p: '兵',
};
