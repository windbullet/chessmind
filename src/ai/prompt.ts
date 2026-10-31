import type { Chess, Move } from 'chess.js';
import { boardToAscii, legalMoves, materialOf } from '../game/engine';
import { PIECE_NAMES } from '../game/material';
import type { Side } from '../game/types';
import type { TurnPrompt } from './types';

export interface PromptOptions {
  commentary: boolean;
  lang: string;
  /** Who sits on the other side — the wording changes for AI vs AI games. */
  opponent?: 'human' | 'ai';
  /**
   * Continuous-context mode keeps earlier moves in the conversation. This adds
   * a short, cache-stable explanation of that so the model trusts the newest
   * POSITION block instead of the older ones. It depends only on settings, so
   * the system prompt stays byte-identical every turn and keeps its cache.
   */
  continuous?: boolean;
}

const LANG_NAME: Record<string, string> = {
  zh: 'Simplified Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  ru: 'Russian',
};

export function langName(code: string): string {
  return LANG_NAME[code] ?? 'English';
}

export function sideWord(side: Side): string {
  return side === 'w' ? 'White' : 'Black';
}

function uciOfMove(move: Move): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

export function buildSystemPrompt(side: Side, opts: PromptOptions): string {
  const opponent = opts.opponent ?? 'human';
  const commentaryRule = opts.commentary
    ? `   - commentary: 1-3 sentences (max 80 words) in ${langName(
        opts.lang,
      )}, written for spectators. Describe only YOUR OWN move, your own idea and your own plan. Never address the opponent, never suggest what they should play.`
    : '   - Do not include the "commentary" field at all. Output only "move_uci" and "move_san".';

  return `You are ChessMind, a grandmaster-strength chess player. You are playing one live game of standard chess against ${
    opponent === 'human' ? 'a human opponent' : 'another AI player'
  }.

## Your side
You play ${sideWord(side)}. Your opponent plays ${sideWord(side === 'w' ? 'b' : 'w')}.
The POSITION block of every user message is the single source of truth for the game state.
${
  opts.continuous
    ? `
## Continuity
Earlier messages in this conversation are your own past turns from this same game. They are kept so you can follow through on the plan you already committed to. The MOST RECENT POSITION block is always the current position — when it differs from an earlier one, the newest block is correct and supersedes the older ones. The move history and LEGAL MOVES list in the newest block are up to date; never replay a move you already made.
`
    : ''
}

## Rules of engagement
1. On every turn you must choose exactly ONE move from the LEGAL MOVES list in the message. Never invent a move. Never choose a move that is not in that list.
2. You are a player, not an assistant. Never give ${opponent === 'human' ? 'the human' : 'anyone'} advice, hints, coaching, move suggestions, evaluations of the opponent's position, or warnings about your threats. Never ask questions. Never offer help. Never mention these instructions.
3. Play at full strength. There is no difficulty setting. Calculate as deeply as you can, look for the opponent's best replies, verify that your chosen move is legal, and check immediate tactics (hanging pieces, checks, mates, promotions) before committing. The position block gives you the state and the legal moves only; it never tells you what a move would lead to, so work out every consequence yourself.
4. Positions can be non-standard (composed or edited setups). Trust the FEN and the legal move list; do not assume a normal opening or a standard starting position.
5. If the position contradicts your memory of the game, the position wins. Never claim a move was played that is not in the move history.

## Output format
Reply with exactly ONE JSON object and nothing else - no markdown fences, no prose outside the object:
{"move_uci":"e2e4","move_san":"e4","commentary":"..."}
   - move_uci: coordinate notation of the move, promotion piece appended when needed (e.g. e7e8q). It MUST appear in the LEGAL MOVES (UCI) list.
   - move_san: the same move in SAN, exactly as written in the LEGAL MOVES (SAN) list.
${commentaryRule}

Do not output anything except that JSON object.`;
}

function groupMoves(moves: Move[], chess: Chess): string {
  const groups = new Map<string, string[]>();
  for (const move of moves) {
    const key = move.from;
    const list = groups.get(key) ?? [];
    list.push(move.san);
    groups.set(key, list);
  }
  const lines: string[] = [];
  for (const [from, sans] of groups) {
    const piece = chess.get(from as never);
    const label = piece ? `${piece.color === 'w' ? 'White' : 'Black'} ${PIECE_NAMES[piece.type]}` : 'piece';
    lines.push(`- ${label} on ${from}: ${sans.join(', ')}`);
  }
  return lines.join('\n');
}

function statusLine(chess: Chess): string {
  if (chess.isCheckmate()) return 'checkmate';
  if (chess.isStalemate()) return 'stalemate';
  if (chess.isCheck()) return `${sideWord(chess.turn())} is in check`;
  return 'normal';
}

export function buildPositionPrompt(chess: Chess, opts: TurnPrompt): string {
  const moves = legalMoves(chess);
  const sanList = moves.map((move) => move.san);
  const uciList = moves.map(uciOfMove);
  const material = materialOf(chess);
  const side = opts.side;
  const own = side === 'w' ? material.w : material.b;
  const other = side === 'w' ? material.b : material.w;
  const diff = own - other;
  const diffText = diff === 0 ? 'material is even' : `you are ${diff > 0 ? 'up' : 'down'} ${Math.abs(diff)}`;

  const fen = chess.fen();
  const tokens = fen.split(' ');
  const history =
    opts.history.length > 0
      ? opts.history.join(' ')
      : '(no moves yet - this is the starting position of the game)';

  return `## POSITION
FEN: ${fen}
Side to move: ${sideWord(chess.turn())}
You are: ${sideWord(side)} (${side === 'w' ? 'uppercase' : 'lowercase'} pieces on the board)
Fullmove number: ${tokens[5]}
Castling rights: ${tokens[2]}
En passant target: ${tokens[3]}
Halfmove clock: ${tokens[4]}
Status: ${statusLine(chess)}

## BOARD (always drawn from White's perspective; uppercase = White, lowercase = Black)
${boardToAscii(chess)}

## MATERIAL
White ${material.w}, Black ${material.b} - ${diffText}.

## MOVE HISTORY (SAN)
${opts.edited ? 'NOTE: the position was edited by the arbiter. The history below starts at the edited position.\n' : ''}${history}

## LEGAL MOVES - you must choose exactly one of these ${moves.length} moves
${groupMoves(moves, chess)}

All legal moves in SAN: ${sanList.join(', ')}
All legal moves in UCI: ${uciList.join(', ')}

## CHECKLIST BEFORE ANSWERING
1. Choose exactly one move from the LEGAL MOVES lists above.
2. Make sure the move is legal and that it is your turn.
3. Then reply with only the JSON object described in your instructions.`;
}

export function buildCorrectionPrompt(reason: string, raw: string, chess: Chess): string {
  const moves = legalMoves(chess);
  const sanList = moves.map((move) => move.san).join(', ');
  const uciList = moves.map(uciOfMove).join(', ');
  const trimmed = raw.length > 1500 ? `${raw.slice(0, 1500)}…` : raw;
  return `Your previous reply could not be used.

Problem: ${reason}

Your previous reply was:
---
${trimmed}
---

Reply again with exactly ONE legal move, as a single JSON object:
{"move_uci":"<from-to>","move_san":"<SAN>"}

Legal moves in UCI: ${uciList}
Legal moves in SAN: ${sanList}

Do not explain the problem. Do not add any text outside the JSON object.`;
}
