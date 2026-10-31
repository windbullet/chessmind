import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ system: string; user: string }>,
  reply: {
    ok: true,
    text: '{"move_review":"好棋","position_read":"均势"}',
    error: null as string | null,
    elapsedMs: 5,
    usage: null,
  },
}));

vi.mock('../src/coach/request', () => ({
  requestCoach: async (opts: { system: string; user: string }) => {
    h.calls.push({ system: opts.system, user: opts.user });
    return h.reply;
  },
}));

/** The engine always plays its first legal move and explains it. */
vi.mock('../src/ai/coordinator', () => ({
  requestAiMove: async (opts: {
    chess: { moves: (arg: { verbose: true }) => Array<Record<string, unknown>> };
    commentary: boolean;
  }) => {
    const move = opts.chess.moves({ verbose: true })[0] as {
      from: string;
      to: string;
      san: string;
      promotion?: string;
    };
    return {
      ok: true,
      move,
      attempts: [],
      reasoning: '',
      commentary: opts.commentary ? '引擎自己的解释' : null,
      usage: null,
      warnings: [],
      exchange: { ply: 0, messages: [] },
    };
  },
}));

const { useGame } = await import('../src/game/store');
const { useSettings } = await import('../src/settings');
const { START_FEN } = await import('../src/game/types');
const { DEFAULT_COACH } = await import('../src/coach/types');
import type { Actor } from '../src/game/types';
import type { CoachConfig } from '../src/coach/types';

/** Let the coach queue (a promise chain) run to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function start(
  players: { w: Actor; b: Actor },
  orientation?: 'w' | 'b',
  coach?: CoachConfig,
  fen?: string,
) {
  useGame.getState().startGame({ players, orientation, coach, fen });
  // startGame schedules an AI turn; unrelated timers must not fire in tests.
  useGame.getState().abortAi();
}

const COACH_ON: CoachConfig = { ...DEFAULT_COACH, enabled: true };

beforeEach(() => {
  h.calls.length = 0;
  h.reply = {
    ok: true,
    text: '{"move_review":"好棋","position_read":"均势"}',
    error: null,
    elapsedMs: 5,
    usage: null,
  };
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
    coach: { ...DEFAULT_COACH },
    coachLog: [],
    coachSummary: null,
    hintBusy: false,
  });
});

afterEach(async () => {
  useGame.getState().abortAi();
  // startGame cancels whatever the coach queue still holds, so one test cannot
  // leak a request into the next one.
  useGame.getState().startGame({ players: { w: 'human', b: 'human' } });
  useGame.getState().abortAi();
  await flush();
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

  it('restores the coach choices that were active before the editor', () => {
    start({ w: 'human', b: 'human' }, 'w', { ...COACH_ON, hint: false });
    useGame.getState().openSetup({
      source: 'new',
      blank: true,
      coach: { ...DEFAULT_COACH },
    });
    expect(useGame.getState().coach.enabled).toBe(false);

    useGame.getState().cancelSetup();

    expect(useGame.getState().coach.enabled).toBe(true);
    expect(useGame.getState().coach.hint).toBe(false);
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

describe('coach mode', () => {
  it('startGame stores and persists the choices made in the dialog', () => {
    start({ w: 'human', b: 'ai' }, 'w', { ...COACH_ON, summary: false, profileId: 'x' });
    expect(useGame.getState().coach.enabled).toBe(true);
    expect(useGame.getState().coach.summary).toBe(false);
    expect(useGame.getState().coachLog).toEqual([]);
    expect(useSettings.getState().settings.coach.enabled).toBe(true);
  });

  it('sends nothing while coach mode is off', async () => {
    start({ w: 'human', b: 'human' });
    useGame.getState().humanMove('e2', 'e4');
    await flush();
    expect(h.calls).toHaveLength(0);
    expect(useGame.getState().coachLog).toEqual([]);
  });

  it('critiques both sides in a local game', async () => {
    start({ w: 'human', b: 'human' }, 'w', COACH_ON);
    useGame.getState().humanMove('e2', 'e4');
    useGame.getState().humanMove('e7', 'e5');
    await flush();

    const log = useGame.getState().coachLog;
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ kind: 'review', ply: 1, side: 'w', san: 'e4' });
    expect(log[1]).toMatchObject({ kind: 'review', ply: 2, side: 'b', san: 'e5' });
    expect(log[0].verdict).toBe('好棋');
    expect(log[0].read).toBe('均势');
    // The critique carries the position the move was played in, so a better
    // move can be named.
    expect(h.calls[0].user).toContain('POSITION BEFORE THE MOVE');
    expect(h.calls[0].user).toContain('Move 1: White played e4.');
  });

  it('only reads the position for engine moves', async () => {
    start({ w: 'ai', b: 'human' }, 'w', COACH_ON);
    useGame.getState().playRandomMove();
    await flush();

    const log = useGame.getState().coachLog;
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe('review');
    expect(log[0].read).toBe('均势');
    expect(log[0].verdict).toBeNull();
    expect(h.calls[0].system).toContain('Do not include a "move_review" field');
    expect(h.calls[0].user).not.toContain('POSITION BEFORE THE MOVE');
  });

  it('puts the engine own explanation on the card instead of a critique', async () => {
    // No abortAi here: the scheduled AI turn has to actually run.
    useGame.getState().startGame({ players: { w: 'ai', b: 'human' }, coach: COACH_ON });
    await new Promise((resolve) => setTimeout(resolve, 700));
    await flush();

    const log = useGame.getState().coachLog;
    expect(log).toHaveLength(1);
    expect(log[0].verdict).toBe('引擎自己的解释');
    expect(log[0].read).toBe('均势');
    expect(log[0].pending).toBe(false);
    expect(h.calls[0].system).toContain('Do not include a "move_review" field');
  });

  it('shows a pending card while the request is still running', async () => {
    start({ w: 'human', b: 'human' }, 'w', COACH_ON);
    useGame.getState().humanMove('e2', 'e4');

    // Synchronously after the move the card exists but is still being filled in.
    const pending = useGame.getState().coachLog[0];
    expect(pending).toMatchObject({ pending: true, verdict: null, read: null });
    expect(pending.expects).toEqual({ verdict: true, read: true });

    await flush();

    const done = useGame.getState().coachLog[0];
    expect(done.pending).toBe(false);
    expect(done.verdict).toBe('好棋');
    expect(done.read).toBe('均势');
  });

  it('never leaves a pending card behind when the game is reset', async () => {
    start({ w: 'human', b: 'human' }, 'w', COACH_ON);
    useGame.getState().humanMove('e2', 'e4');
    expect(useGame.getState().coachLog[0].pending).toBe(true);

    useGame.getState().finishGame('resigned');

    expect(useGame.getState().coachLog.some((entry) => entry.pending)).toBe(false);
  });

  it('never sends a coach request when every option is off', async () => {
    start({ w: 'human', b: 'human' }, 'w', {
      ...COACH_ON,
      opponentMoves: false,
      position: false,
      summary: false,
      hint: false,
    });
    useGame.getState().humanMove('e2', 'e4');
    useGame.getState().askHint();
    await flush();
    expect(h.calls).toHaveLength(0);
  });

  it('answers a hint request and replaces it when asked again', async () => {
    h.reply = { ok: true, text: '{"suggestion_san":"e2e4","why":"占中心"}', error: null, elapsedMs: 5, usage: null };
    start({ w: 'human', b: 'ai' }, 'w', COACH_ON);

    useGame.getState().askHint();
    await flush();

    let hints = useGame.getState().coachLog.filter((entry) => entry.kind === 'hint');
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ san: 'e4', verdict: '占中心', ply: 0 });

    useGame.getState().askHint();
    await flush();

    hints = useGame.getState().coachLog.filter((entry) => entry.kind === 'hint');
    expect(hints).toHaveLength(1);
  });

  it('refuses a hint when it is not the human turn', async () => {
    start({ w: 'ai', b: 'human' }, 'w', COACH_ON);
    useGame.getState().askHint();
    await flush();
    expect(h.calls).toHaveLength(0);
    expect(useGame.getState().hintBusy).toBe(false);
  });

  it('reviews the whole game only after a natural end', async () => {
    h.reply = {
      ok: true,
      text: '{"summary":"转折在最后一手"}',
      error: null,
      elapsedMs: 5,
      usage: null,
    };
    // Rh8 is mate.
    start({ w: 'human', b: 'human' }, 'w', COACH_ON, 'k7/8/1K6/8/8/8/8/7R w - - 0 1');
    useGame.getState().humanMove('h1', 'h8');
    await flush();

    const summary = useGame.getState().coachSummary;
    expect(summary?.state).toBe('done');
    expect(summary?.text).toBe('转折在最后一手');
    expect(h.calls.some((call) => call.user.includes('## GAME'))).toBe(true);
  });

  it('does not review a game that was ended by hand', async () => {
    start({ w: 'human', b: 'human' }, 'w', COACH_ON);
    useGame.getState().humanMove('e2', 'e4');
    await flush();
    h.calls.length = 0;

    useGame.getState().finishGame('resigned');
    await flush();

    expect(useGame.getState().coachSummary).toBeNull();
    expect(h.calls.some((call) => call.user.includes('## GAME'))).toBe(false);
  });

  it('drops remarks about positions that an undo removed', async () => {
    start({ w: 'human', b: 'human' }, 'w', COACH_ON);
    useGame.getState().humanMove('e2', 'e4');
    useGame.getState().humanMove('e7', 'e5');
    await flush();
    expect(useGame.getState().coachLog).toHaveLength(2);

    useGame.getState().undo();

    expect(useGame.getState().coachLog.map((entry) => entry.ply)).toEqual([1]);
    expect(useGame.getState().coachSummary).toBeNull();
  });

  it('records a failed coach request without touching the game', async () => {
    h.reply = { ok: false, text: '', error: '429 限流', elapsedMs: 5, usage: null };
    start({ w: 'human', b: 'human' }, 'w', COACH_ON);
    useGame.getState().humanMove('e2', 'e4');
    await flush();

    const entry = useGame.getState().coachLog[0];
    expect(entry.error).toBe('429 限流');
    expect(useGame.getState().mode).toBe('playing');
    expect(useGame.getState().aiError).toBeNull();
  });
});
