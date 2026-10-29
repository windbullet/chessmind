import { useEffect, useMemo, useState } from 'react';
import type { PieceSymbol } from 'chess.js';
import {
  ArrowLeftRight,
  Check,
  ClipboardCopy,
  ClipboardPaste,
  Crown,
  Eraser,
  FlipVertical2,
  PlusCircle,
  Redo2,
  RotateCcw,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useEditor } from '../editorTool';
import { PIECE_LABELS, PIECE_TYPES } from '../game/pieceTypes';
import { castlingAvailable, countPieces, draftToFen } from '../game/setup';
import { useGame } from '../game/store';
import type { Side } from '../game/types';
import { PieceGlyph } from './board/PieceGlyph';

export function SetupEditor() {
  const draft = useGame((s) => s.setupDraft);
  const validation = useGame((s) => s.setupValidation);
  const source = useGame((s) => s.setupSource);
  const players = useGame((s) => s.players);
  const setSetupTurn = useGame((s) => s.setSetupTurn);
  const toggleSetupCastling = useGame((s) => s.toggleSetupCastling);
  const setSetupCounters = useGame((s) => s.setSetupCounters);
  const clearSetupBoard = useGame((s) => s.clearSetupBoard);
  const resetSetupStandard = useGame((s) => s.resetSetupStandard);
  const setupKingsOnly = useGame((s) => s.setupKingsOnly);
  const loadSetupFen = useGame((s) => s.loadSetupFen);
  const setupUndo = useGame((s) => s.setupUndo);
  const setupRedo = useGame((s) => s.setupRedo);
  const setupPast = useGame((s) => s.setupPast);
  const setupFuture = useGame((s) => s.setupFuture);
  const applySetup = useGame((s) => s.applySetup);
  const cancelSetup = useGame((s) => s.cancelSetup);
  const flip = useGame((s) => s.flip);
  const notify = useGame((s) => s.notify);

  const piece = useEditor((s) => s.piece);
  const tool = useEditor((s) => s.tool);
  const setPiece = useEditor((s) => s.setPiece);
  const setTool = useEditor((s) => s.setTool);

  const [fenInput, setFenInput] = useState('');

  // Palette shortcuts: 1-6 pick a piece type, W/B switch colour, Esc drops the tool.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const index = Number.parseInt(event.key, 10);
      if (Number.isInteger(index) && index >= 1 && index <= PIECE_TYPES.length) {
        event.preventDefault();
        const active = useEditor.getState().piece;
        setPiece({ type: PIECE_TYPES[index - 1], color: active?.color ?? 'w' });
        return;
      }
      if (event.key === 'w' || event.key === 'W') setPiece({ type: piece?.type ?? 'q', color: 'w' });
      if (event.key === 'b' || event.key === 'B') setPiece({ type: piece?.type ?? 'q', color: 'b' });
      if (event.key === 'Escape') setTool('place');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [piece?.type, setPiece, setTool]);

  const counts = useMemo(() => (draft ? countPieces(draft) : { w: 0, b: 0 }), [draft]);
  if (!draft) return null;

  const fen = draftToFen(draft);
  const canStart = validation?.ok ?? false;

  const copyFen = async () => {
    try {
      await navigator.clipboard.writeText(fen);
      notify('FEN 已复制到剪贴板', 'success');
    } catch {
      notify('无法访问剪贴板，可手动选中下方 FEN 文本复制', 'error');
    }
  };

  const castlingChip = (color: Side, side: 'k' | 'q') => {
    const enabled = draft.castling[color][side];
    const available = castlingAvailable(draft, color, side);
    const label = `${color === 'w' ? '白' : '黑'}${side === 'k' ? '王翼' : '后翼'}`;
    return (
      <button
        type="button"
        className="castling-chip"
        data-on={enabled}
        disabled={!available}
        title={available ? `切换${label}易位权` : '王与车必须在初始格才能易位'}
        onClick={() => toggleSetupCastling(color, side)}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="editor-bar">
      <div className="editor-head">
        <span className="editor-badge">
          <PlusCircle size={13} /> 摆棋编辑器
        </span>
        <span className="faint" style={{ fontSize: 12 }}>
          {source === 'midgame'
            ? '编辑当前局面：可增删棋子、拖动棋子，确认后继续对局'
            : '自由摆放开局：点选棋子后点击棋盘放置，右键删除，拖拽移动'}
        </span>
        <div className="editor-actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={setupUndo}
            disabled={setupPast.length === 0}
            title="撤销上一步编辑"
          >
            <Undo2 size={13} /> 撤销
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={setupRedo}
            disabled={setupFuture.length === 0}
            title="重做"
          >
            <Redo2 size={13} /> 重做
          </button>
          <button type="button" className="btn btn--sm" onClick={flip} title="翻转棋盘">
            <FlipVertical2 size={13} /> 翻转
          </button>
          <button type="button" className="btn btn--sm" onClick={cancelSetup} title="放弃编辑并返回">
            <X size={13} /> 取消
          </button>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => applySetup()}
            disabled={!canStart}
            title={canStart ? '应用局面并开始/继续对局' : '局面不合法，无法开始'}
          >
            <Check size={13} /> {source === 'midgame' ? '应用并继续' : '开始对局'}
          </button>
        </div>
      </div>

      <div className="palette">
        <span className="palette-label">白</span>
        {PIECE_TYPES.map((type: PieceSymbol) => (
          <button
            key={`w${type}`}
            type="button"
            className="palette-item"
            data-active={tool === 'place' && piece?.type === type && piece.color === 'w'}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(
                'application/x-chessmind-piece',
                JSON.stringify({ type, color: 'w' }),
              );
              event.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => setPiece({ type, color: 'w' })}
            title={`放置白${PIECE_LABELS[type]}`}
          >
            <PieceGlyph type={type} color="w" size={30} />
          </button>
        ))}
        <span className="palette-sep" />
        <span className="palette-label">黑</span>
        {PIECE_TYPES.map((type: PieceSymbol) => (
          <button
            key={`b${type}`}
            type="button"
            className="palette-item"
            data-active={tool === 'place' && piece?.type === type && piece.color === 'b'}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(
                'application/x-chessmind-piece',
                JSON.stringify({ type, color: 'b' }),
              );
              event.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => setPiece({ type, color: 'b' })}
            title={`放置黑${PIECE_LABELS[type]}`}
          >
            <PieceGlyph type={type} color="b" size={30} />
          </button>
        ))}
        <span className="palette-sep" />
        <button
          type="button"
          className="palette-item palette-item--tool"
          data-active={tool === 'erase'}
          onClick={() => setTool('erase')}
          title="橡皮擦：点击棋盘上的棋子删除它"
        >
          <Eraser size={19} />
        </button>
        <span className="palette-sep" />
        <button type="button" className="btn btn--sm" onClick={resetSetupStandard}>
          <RotateCcw size={13} /> 标准开局
        </button>
        <button type="button" className="btn btn--sm" onClick={setupKingsOnly}>
          <Crown size={13} /> 只留双方王
        </button>
        <button type="button" className="btn btn--sm btn--danger" onClick={clearSetupBoard}>
          <Trash2 size={13} /> 清空
        </button>
        <span className="faint mono" style={{ fontSize: 11.5, marginLeft: 'auto' }}>
          白 {counts.w} · 黑 {counts.b}
        </span>
      </div>

      <div className="editor-fields">
        <div className="editor-field">
          <span>行棋方</span>
          <div className="segmented">
            <button type="button" data-active={draft.turn === 'w'} onClick={() => setSetupTurn('w')}>
              <ArrowLeftRight size={12} /> 白方
            </button>
            <button type="button" data-active={draft.turn === 'b'} onClick={() => setSetupTurn('b')}>
              黑方
            </button>
          </div>
        </div>
        <div className="editor-field">
          <span>易位权</span>
          <div className="castling-group">
            {castlingChip('w', 'k')}
            {castlingChip('w', 'q')}
            {castlingChip('b', 'k')}
            {castlingChip('b', 'q')}
          </div>
        </div>
        <div className="editor-field">
          <span>回合数</span>
          <input
            className="input"
            type="number"
            min={1}
            value={draft.moveNumber}
            onChange={(event) => setSetupCounters(draft.halfmove, Number(event.target.value) || 1)}
          />
        </div>
        <div className="editor-field">
          <span>半回合钟</span>
          <input
            className="input"
            type="number"
            min={0}
            value={draft.halfmove}
            onChange={(event) => setSetupCounters(Number(event.target.value) || 0, draft.moveNumber)}
          />
        </div>
      </div>

      <div className="fen-box">
        <span className="faint" style={{ fontSize: 12, flex: '0 0 auto' }}>
          FEN
        </span>
        <input
          className="input"
          value={fenInput}
          placeholder="粘贴 FEN 后按回车载入"
          onChange={(event) => setFenInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && fenInput.trim()) {
              loadSetupFen(fenInput.trim());
              setFenInput('');
            }
          }}
        />
        <button
          type="button"
          className="btn btn--sm"
          title="载入粘贴的 FEN"
          onClick={() => {
            if (fenInput.trim()) {
              loadSetupFen(fenInput.trim());
              setFenInput('');
            }
          }}
        >
          <ClipboardPaste size={13} /> 载入
        </button>
        <button type="button" className="btn btn--sm" onClick={copyFen} title="复制当前 FEN">
          <ClipboardCopy size={13} /> 复制
        </button>
      </div>

      <div className="setup-problems">
        {validation?.errors.map((error) => (
          <div className="problem" data-kind="error" key={error}>
            <X size={13} style={{ marginTop: 2, flex: '0 0 auto' }} />
            <span>{error}</span>
          </div>
        ))}
        {validation?.warnings.map((warning) => (
          <div className="problem" data-kind="warn" key={warning}>
            <span style={{ marginTop: 1, flex: '0 0 auto', fontWeight: 700 }}>!</span>
            <span>{warning}</span>
          </div>
        ))}
        {canStart && (
          <div className="problem" data-kind="ok">
            <Check size={13} style={{ marginTop: 2, flex: '0 0 auto' }} />
            <span>
              局面合法，可以{source === 'midgame' ? '继续' : '开始'}对局（
              {players[draft.turn] === 'ai' ? 'AI' : '人类'}执
              {draft.turn === 'w' ? '白' : '黑'}先行）
            </span>
          </div>
        )}
      </div>

      <div className="faint mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
        {fen}
      </div>
    </div>
  );
}
