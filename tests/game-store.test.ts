import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useGame } from '../src/game/store';
import { useSettings } from '../src/settings';
import { START_FEN } from '../src/game/types';
import type { Actor } from '../src/game/types';

function start(players: { w: Actor; b: Actor }, orientation?: 'w' | 'b') {
  useGame.getState().startGame({ players, orientation });
  // startGame schedules an AI turn; unrelated timers must not fire in tests.
  useGame.getState().abortAi();
}

beforeEach(() => {
  useGame.setState({
    mode: 'idle',
    players: { w: 'human', b: 'human' },
    orientation: 'w',
    setupDraft: null,
    setupValidation: null,
    setupReturn: null,
    setupReturnSides: null,
    setupSource: null,
    thinking: false,
    aiTurn: null,
    aiError: null,
    fen: START_FEN,
    turn: 'w',
    moveLog: [],
    lastMove: null,
  });
});

afterEach(() => {
  useGame.getState().abortAi();
});

describe('playRandomMove', () => {
  it('plays a move for the AI even when the game is paused after a failure', () => {
    start({ w: 'ai', b: 'human' });
    useGame.setState({ mode: 'paused', aiError: '请求失败' });
    const before = useGame.getState().moveLog.length;

    useGame.getState().playRandomMove();

    const after = useGame.getState();
    expect(after.moveLog.length).toBe(before + 1);
    expect(after.mode).toBe('playing');
    expect(after.aiError).toBeNull();
    expect(after.players.w).toBe('ai');
  });

  it('does nothing while a request is in flight', () => {
    start({ w: 'ai', b: 'human' });
    useGame.setState({ thinking: true });
    const before = useGame.getState().moveLog.length;
    useGame.getState().playRandomMove();
    expect(useGame.getState().moveLog.length).toBe(before);
  });
});

describe('setup cancel', () => {
  it('restores the players and orientation that were active before the editor', () => {
    start({ w: 'human', b: 'human' }, 'w');
    useGame.getState().openSetup({
      source: 'new',
      blank: true,
      players: { w: 'ai', b: 'human' },
      orientation: 'b',
    });
    expect(useGame.getState().mode).toBe('setup');
    expect(useGame.getState().players).toEqual({ w: 'ai', b: 'human' });
    expect(useGame.getState().orientation).toBe('b');

    useGame.getState().cancelSetup();

    expect(useGame.getState().mode).toBe('playing');
    expect(useGame.getState().players).toEqual({ w: 'human', b: 'human' });
    expect(useGame.getState().orientation).toBe('w');
  });
});

describe('orientation persistence', () => {
  it('startGame saves the chosen orientation', () => {
    start({ w: 'human', b: 'human' }, 'b');
    expect(useSettings.getState().settings.orientation).toBe('b');
  });

  it('flip saves the new orientation', () => {
    start({ w: 'human', b: 'human' }, 'w');
    useGame.getState().flip();
    expect(useGame.getState().orientation).toBe('b');
    expect(useSettings.getState().settings.orientation).toBe('b');
  });
});
