import type { PieceSymbol } from 'chess.js';
import type { Side } from '../../game/types';
import { Piece } from './Piece';

export interface GlyphProps {
  type: PieceSymbol;
  color: Side;
  size?: number;
  dim?: boolean;
}

/**
 * A small framed piece preview used by palettes, player cards and dialogs.
 * The frame is neutral for both colours: white pieces carry a dark outline and
 * black pieces a light one, so both read on the same tile.
 */
export function PieceGlyph({ type, color, size = 30, dim }: GlyphProps) {
  return (
    <span
      className="piece-glyph"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.26),
        opacity: dim ? 0.4 : 1,
      }}
    >
      <Piece type={type} color={color} />
    </span>
  );
}
