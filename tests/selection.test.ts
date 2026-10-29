import { describe, expect, it } from 'vitest';
import { profileFor } from '../src/settings';
import { DEFAULT_AI } from '../src/config';
import type { AppSettings } from '../src/config';
import type { AiProfile } from '../src/ai/types';

function profile(id: string, name: string, model: string): AiProfile {
  return { id, name, config: { ...DEFAULT_AI, model } };
}

/** A settings object with two very different profiles, one per side. */
function twoSided(): AppSettings {
  return {
    aiProfiles: [profile('a', 'Claude', 'claude-sonnet-4-6'), profile('b', 'GPT', 'gpt-5')],
    aiSelection: { w: 'a', b: 'b' },
    activeProfile: 'a',
    ui: {
      theme: 'dark',
      boardTheme: 'midnight',
      showCoordinates: true,
      showReasoning: true,
      commentaryEnabled: true,
      commentaryLang: 'zh',
    },
    players: { w: 'ai', b: 'ai' },
    orientation: 'w',
  };
}

describe('per-side AI selection', () => {
  it('resolves a different profile for each side', () => {
    const settings = twoSided();
    expect(profileFor(settings, 'w').name).toBe('Claude');
    expect(profileFor(settings, 'b').name).toBe('GPT');
  });

  it('falls back to the first profile if a selection is stale', () => {
    const settings = twoSided();
    settings.aiSelection = { w: 'missing', b: 'b' };
    expect(profileFor(settings, 'w').id).toBe('a');
    expect(profileFor(settings, 'b').id).toBe('b');
  });

  it('keeps both sides on the same profile when only one exists', () => {
    const settings = twoSided();
    settings.aiProfiles = [profile('only', 'Only', 'gpt-4o')];
    expect(profileFor(settings, 'w').id).toBe('only');
    expect(profileFor(settings, 'b').id).toBe('only');
  });

  it('a profile edit only affects that profile', () => {
    const settings = twoSided();
    settings.aiProfiles = settings.aiProfiles.map((p) =>
      p.id === 'a' ? { ...p, config: { ...p.config, model: 'claude-opus-4-6' } } : p,
    );
    expect(profileFor(settings, 'w').config.model).toBe('claude-opus-4-6');
    expect(profileFor(settings, 'b').config.model).toBe('gpt-5');
  });
});
