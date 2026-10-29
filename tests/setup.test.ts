import { describe, expect, it } from 'vitest';
import {
  boardFromFen,
  castlingAvailable,
  cloneDraft,
  countPieces,
  draftFromFen,
  draftToFen,
  emptyDraft,
  kingsOnlyDraft,
  moveDraftPiece,
  normalizeCastling,
  squareIndex,
  standardDraft,
  toggleSquarePiece,
  validateDraft,
} from '../src/game/setup';

describe('setup draft model', () => {
  it('round-trips a standard FEN', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(draftToFen(draftFromFen(fen))).toBe(fen);
  });

  it('round-trips an edited FEN with side to move and counters', () => {
    const fen = '4k3/8/8/8/8/8/4P3/4K3 b - - 7 42';
    expect(draftToFen(draftFromFen(fen))).toBe(fen);
  });

  it('places, replaces and removes pieces (add / delete)', () => {
    let draft = emptyDraft('w');
    draft = toggleSquarePiece(draft, 'e1', { type: 'k', color: 'w' });
    draft = toggleSquarePiece(draft, 'e8', { type: 'k', color: 'b' });
    draft = toggleSquarePiece(draft, 'd4', { type: 'q', color: 'w' });
    expect(countPieces(draft)).toEqual({ w: 2, b: 1 });

    // replace the queen with a rook
    draft = toggleSquarePiece(draft, 'd4', { type: 'r', color: 'w' });
    expect(draft.squares[squareIndex('d4')]?.type).toBe('r');

    // delete it
    draft = toggleSquarePiece(draft, 'd4', null);
    expect(draft.squares[squareIndex('d4')]).toBeNull();
    expect(countPieces(draft)).toEqual({ w: 1, b: 1 });
  });

  it('moves a piece between squares', () => {
    let draft = emptyDraft('w');
    draft = toggleSquarePiece(draft, 'a1', { type: 'r', color: 'w' });
    draft = moveDraftPiece(draft, 'a1', 'a4');
    expect(draft.squares[squareIndex('a1')]).toBeNull();
    expect(draft.squares[squareIndex('a4')]?.type).toBe('r');
  });

  it('allows non-standard material (three queens)', () => {
    let draft = standardDraft();
    draft = toggleSquarePiece(draft, 'd4', { type: 'q', color: 'w' });
    draft = toggleSquarePiece(draft, 'e4', { type: 'q', color: 'w' });
    expect(validateDraft(cloneDraft(draft)).ok).toBe(true);
  });

  it('rejects a position without kings', () => {
    const draft = emptyDraft('w');
    const validation = validateDraft(cloneDraft(draft));
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toContain('缺少白方国王');
    expect(validation.errors.join(' ')).toContain('缺少黑方国王');
  });

  it('rejects a position with two white kings', () => {
    let draft = kingsOnlyDraft();
    draft = toggleSquarePiece(draft, 'a1', { type: 'k', color: 'w' });
    const validation = validateDraft(cloneDraft(draft));
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toContain('白方有多个国王');
  });

  it('rejects pawns on the first or eighth rank', () => {
    let draft = kingsOnlyDraft();
    draft = toggleSquarePiece(draft, 'a8', { type: 'p', color: 'w' });
    const validation = validateDraft(cloneDraft(draft));
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toContain('兵不能放在第 8 横线');
  });

  it('rejects adjacent kings', () => {
    let draft = emptyDraft('w');
    draft = toggleSquarePiece(draft, 'e1', { type: 'k', color: 'w' });
    draft = toggleSquarePiece(draft, 'e2', { type: 'k', color: 'b' });
    const validation = validateDraft(cloneDraft(draft));
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toContain('双方国王不能相邻');
  });

  it('rejects a position where the side not to move is in check', () => {
    // Black king on e8 attacked by a white rook on e1 while White is to move.
    let draft = emptyDraft('w');
    draft = toggleSquarePiece(draft, 'e1', { type: 'k', color: 'w' });
    draft = toggleSquarePiece(draft, 'e8', { type: 'k', color: 'b' });
    draft = toggleSquarePiece(draft, 'e4', { type: 'r', color: 'w' });
    const validation = validateDraft(cloneDraft(draft));
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toContain('未行棋却被将军');
  });

  it('accepts a legal composed position', () => {
    let draft = emptyDraft('w');
    draft = toggleSquarePiece(draft, 'e1', { type: 'k', color: 'w' });
    draft = toggleSquarePiece(draft, 'e8', { type: 'k', color: 'b' });
    draft = toggleSquarePiece(draft, 'd4', { type: 'q', color: 'w' });
    draft = toggleSquarePiece(draft, 'a7', { type: 'p', color: 'b' });
    expect(validateDraft(cloneDraft(draft)).ok).toBe(true);
  });

  it('only offers castling rights when king and rook are on their home squares', () => {
    const standard = standardDraft();
    expect(castlingAvailable(standard, 'w', 'k')).toBe(true);
    expect(castlingAvailable(standard, 'b', 'q')).toBe(true);

    const moved = toggleSquarePiece(standard, 'h1', null);
    expect(castlingAvailable(moved, 'w', 'k')).toBe(false);
    expect(castlingAvailable(moved, 'w', 'q')).toBe(true);
  });

  it('warns about castling rights that can no longer be used', () => {
    const draft = standardDraft();
    draft.squares[squareIndex('h1')] = null;
    const validation = validateDraft(cloneDraft(draft));
    expect(validation.ok).toBe(true);
    expect(validation.warnings.join(' ')).toContain('易位权无效');
  });

  it('drops stranded castling rights instead of keeping them in the FEN', () => {
    const draft = standardDraft();
    draft.squares[squareIndex('h1')] = null;
    const normalized = normalizeCastling(draft);
    expect(normalized.castling.w.k).toBe(false);
    expect(normalized.castling.w.q).toBe(true);
    expect(draftToFen(normalized).split(' ')[2]).toBe('Qkq');
  });

  it('parses a FEN board field with empty ranks', () => {
    const squares = boardFromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
    expect(squares[squareIndex('e8')]).toEqual({ type: 'k', color: 'b' });
    expect(squares[squareIndex('e1')]).toEqual({ type: 'k', color: 'w' });
    expect(squares[squareIndex('a1')]).toBeNull();
  });
});
