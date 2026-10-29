import { create } from 'zustand';
import type { PieceSymbol } from 'chess.js';
import type { Side } from './game/types';

export type EditorTool = 'place' | 'erase';

interface EditorState {
  piece: { type: PieceSymbol; color: Side } | null;
  tool: EditorTool;
  setPiece(piece: { type: PieceSymbol; color: Side } | null): void;
  setTool(tool: EditorTool): void;
  setColor(color: Side): void;
  reset(): void;
}

/** Which piece the setup editor paints with. Shared by the palette and the board. */
export const useEditor = create<EditorState>((set, get) => ({
  piece: { type: 'q', color: 'w' },
  tool: 'place',
  setPiece(piece) {
    set({ piece, tool: 'place' });
  },
  setTool(tool) {
    set({ tool });
  },
  setColor(color) {
    const current = get().piece;
    set({ piece: current ? { ...current, color } : { type: 'q', color }, tool: 'place' });
  },
  reset() {
    set({ tool: 'place' });
  },
}));
