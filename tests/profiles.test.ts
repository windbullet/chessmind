import { describe, expect, it } from 'vitest';
import { DEFAULT_AI, DEFAULT_PROFILE_ID, DEFAULT_SETTINGS, sanitizeSettings } from '../src/config';
import type { AiProfile } from '../src/ai/types';

function profile(id: string, name: string, model = 'gpt-4o'): AiProfile {
  return { id, name, config: { ...DEFAULT_AI, model } };
}

describe('settings migration', () => {
  it('creates one default profile on a fresh install', () => {
    const settings = sanitizeSettings(null);
    expect(settings.aiProfiles).toHaveLength(1);
    expect(settings.aiProfiles[0].id).toBe(DEFAULT_PROFILE_ID);
    expect(settings.aiSelection).toEqual({ w: DEFAULT_PROFILE_ID, b: DEFAULT_PROFILE_ID });
  });

  it('migrates the old single `ai` object into a profile', () => {
    const settings = sanitizeSettings({
      ai: { ...DEFAULT_AI, model: 'deepseek-chat', apiKey: 'sk-old' },
      ui: DEFAULT_SETTINGS.ui,
    });
    expect(settings.aiProfiles).toHaveLength(1);
    expect(settings.aiProfiles[0].config.model).toBe('deepseek-chat');
    expect(settings.aiProfiles[0].config.apiKey).toBe('sk-old');
    expect(settings.aiSelection.w).toBe(settings.aiProfiles[0].id);
  });

  it('keeps several profiles and their per-side selection', () => {
    const settings = sanitizeSettings({
      aiProfiles: [profile('a', 'Claude', 'claude-sonnet-4-6'), profile('b', 'GPT-5', 'gpt-5')],
      aiSelection: { w: 'a', b: 'b' },
      activeProfile: 'b',
    });
    expect(settings.aiProfiles.map((p) => p.name)).toEqual(['Claude', 'GPT-5']);
    expect(settings.aiSelection).toEqual({ w: 'a', b: 'b' });
    expect(settings.activeProfile).toBe('b');
  });

  it('repoints a selection that refers to a deleted profile', () => {
    const settings = sanitizeSettings({
      aiProfiles: [profile('a', 'Claude'), profile('b', 'GPT-5')],
      aiSelection: { w: 'gone', b: 'b' },
      activeProfile: 'also-gone',
    });
    expect(settings.aiSelection).toEqual({ w: 'a', b: 'b' });
    expect(settings.activeProfile).toBe('a');
  });

  it('drops duplicate and malformed profiles', () => {
    const settings = sanitizeSettings({
      aiProfiles: [profile('a', 'One'), profile('a', 'Duplicate'), { id: '', name: 'No id' }, 'nonsense'],
    });
    expect(settings.aiProfiles).toHaveLength(1);
    expect(settings.aiProfiles[0].name).toBe('One');
  });

  it('never returns an empty profile list', () => {
    const settings = sanitizeSettings({ aiProfiles: [] });
    expect(settings.aiProfiles).toHaveLength(1);
    expect(settings.aiProfiles[0].id).toBe(DEFAULT_PROFILE_ID);
  });

  it('gives unnamed profiles a readable fallback name', () => {
    const settings = sanitizeSettings({ aiProfiles: [{ id: 'x', name: '   ', config: {} }] });
    expect(settings.aiProfiles[0].name).toBe('未命名配置');
  });

  it('sanitizes each profile config independently', () => {
    const settings = sanitizeSettings({
      aiProfiles: [
        { id: 'a', name: 'Bad protocol', config: { protocol: 'nope', maxTokens: 1e9 } },
        { id: 'b', name: 'Good', config: { protocol: 'anthropic', model: 'claude-sonnet-4-6' } },
      ],
    });
    expect(settings.aiProfiles[0].config.protocol).toBe(DEFAULT_AI.protocol);
    expect(settings.aiProfiles[0].config.maxTokens).toBe(200000);
    expect(settings.aiProfiles[1].config.protocol).toBe('anthropic');
  });
});
