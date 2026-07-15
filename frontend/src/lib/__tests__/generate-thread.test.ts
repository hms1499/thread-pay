import { describe, expect, it } from 'vitest';
import { parseThreadJson, resolveLlmConfig, extractText, parseHook, assembleThread, languageInstruction, assertApiKey, parseHookAndOutline, buildThreadPrompt, buildHookPrompt, buildHookOutlinePrompt, buildRegeneratePrompt, TONE_GUIDE, CRAFT_GUIDE, ENDING_GUIDE, HOOK_GUIDE, TONE_EXEMPLARS } from '../generate-thread';

describe('languageInstruction', () => {
  it('forces a known language by its English name', () => {
    expect(languageInstruction('vi')).toBe(
      'Write the entire thread in Vietnamese, regardless of the language of the topic.',
    );
    expect(languageInstruction('es')).toContain('in Spanish');
  });

  it('defers to the topic language for auto', () => {
    expect(languageInstruction('auto')).toBe(
      'Write in the same language as the topic given by the user.',
    );
  });

  it('defers to the topic language for unknown, null, or undefined', () => {
    const fallback = 'Write in the same language as the topic given by the user.';
    expect(languageInstruction('klingon')).toBe(fallback);
    expect(languageInstruction(null)).toBe(fallback);
    expect(languageInstruction(undefined)).toBe(fallback);
  });
});

describe('parseThreadJson', () => {
  it('parses a plain JSON array', () => {
    expect(parseThreadJson('["tweet 1", "tweet 2"]')).toEqual(['tweet 1', 'tweet 2']);
  });

  it('parses when wrapped in a code fence', () => {
    const raw = '```json\n["a", "b", "c"]\n```';
    expect(parseThreadJson(raw)).toEqual(['a', 'b', 'c']);
  });

  it('truncates tweets over 280 chars', () => {
    const long = 'x'.repeat(300);
    const out = parseThreadJson(JSON.stringify([long]));
    expect(out[0].length).toBeLessThanOrEqual(280);
  });

  it('throws when not an array of strings', () => {
    expect(() => parseThreadJson('{"a":1}')).toThrow();
    expect(() => parseThreadJson('not json')).toThrow();
  });

  it('unwraps an object wrapper like {"tweets":[...]}', () => {
    expect(parseThreadJson('{"tweets":["a","b"]}')).toEqual(['a', 'b']);
    expect(parseThreadJson('{"thread":["x"]}')).toEqual(['x']);
  });

  it('extracts the JSON array from surrounding prose', () => {
    const raw = 'Sure! Here is your thread:\n["one", "two"]\nHope that helps!';
    expect(parseThreadJson(raw)).toEqual(['one', 'two']);
  });

  it('extracts a JSON object wrapper from surrounding prose', () => {
    const raw = 'Here you go:\n```json\n{"tweets": ["a", "b"]}\n```\nEnjoy';
    expect(parseThreadJson(raw)).toEqual(['a', 'b']);
  });
});

describe('resolveLlmConfig', () => {
  it('defaults to groq with the llama 3.3 model', () => {
    const c = resolveLlmConfig({ GROQ_API_KEY: 'k' });
    expect(c.provider).toBe('groq');
    expect(c.baseUrl).toContain('groq.com');
    expect(c.model).toContain('llama');
    expect(c.apiKey).toBe('k');
  });

  it('reads LLM_PROVIDER to switch provider', () => {
    const c = resolveLlmConfig({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'g' });
    expect(c.provider).toBe('gemini');
    expect(c.apiKey).toBe('g');
  });

  it('LLM_MODEL overrides the default model', () => {
    const c = resolveLlmConfig({ LLM_PROVIDER: 'openrouter', LLM_MODEL: 'org/x:free' });
    expect(c.model).toBe('org/x:free');
  });

  it('ollama needs no api key', () => {
    const c = resolveLlmConfig({ LLM_PROVIDER: 'ollama' });
    expect(c.provider).toBe('ollama');
    expect(c.apiKey).toBe('');
  });

  it('throws for an unknown provider', () => {
    expect(() => resolveLlmConfig({ LLM_PROVIDER: 'foobar' })).toThrow();
  });
});

describe('parseHook', () => {
  it('returns a single string from a JSON array', () => {
    expect(parseHook('["a strong hook"]')).toBe('a strong hook');
  });

  it('returns the string from a {"tweet": "..."} wrapper', () => {
    expect(parseHook('{"tweet":"hooky"}')).toBe('hooky');
  });

  it('returns a bare quoted string', () => {
    expect(parseHook('"just a hook"')).toBe('just a hook');
  });

  it('truncates a hook over 280 chars', () => {
    const long = 'x'.repeat(300);
    const out = parseHook(JSON.stringify([long]));
    expect(out.length).toBeLessThanOrEqual(280);
    expect(out).toMatch(/\.\.\.$/);
  });

  it('throws when there is no usable string', () => {
    expect(() => parseHook('{"a":1}')).toThrow();
  });

  it('throws on a whitespace-only string', () => {
    expect(() => parseHook('"   "')).toThrow();
  });
});

describe('assembleThread', () => {
  it('pins the given first tweet and appends the rest', () => {
    expect(assembleThread('HOOK', ['b', 'c'], 3)).toEqual(['HOOK', 'b', 'c']);
  });

  it('trims to length when the model returns too many', () => {
    expect(assembleThread('HOOK', ['b', 'c', 'd', 'e'], 3)).toEqual(['HOOK', 'b', 'c']);
  });

  it('returns the rest unchanged when no first tweet is pinned', () => {
    expect(assembleThread(null, ['a', 'b'], 5)).toEqual(['a', 'b']);
  });

  it('caps the no-firstTweet branch to length too', () => {
    expect(assembleThread(null, ['a', 'b', 'c', 'd', 'e', 'f'], 3)).toEqual(['a', 'b', 'c']);
  });

  it('returns just the pinned tweet when the model adds nothing', () => {
    expect(assembleThread('HOOK', [], 5)).toEqual(['HOOK']);
  });
});

describe('assertApiKey', () => {
  it('throws when a non-ollama provider has no key', () => {
    expect(() =>
      assertApiKey({ provider: 'groq', baseUrl: 'x', model: 'm', apiKey: '' }),
    ).toThrow(/GROQ_API_KEY/);
  });
  it('passes for ollama with no key', () => {
    expect(() =>
      assertApiKey({ provider: 'ollama', baseUrl: 'x', model: 'm', apiKey: '' }),
    ).not.toThrow();
  });
  it('passes when a key is present', () => {
    expect(() =>
      assertApiKey({ provider: 'groq', baseUrl: 'x', model: 'm', apiKey: 'k' }),
    ).not.toThrow();
  });
});

describe('extractText', () => {
  it('extracts text from the OpenAI-compatible shape (groq/openrouter/ollama)', () => {
    const json = { choices: [{ message: { content: '["a","b"]' } }] };
    expect(extractText('groq', json)).toBe('["a","b"]');
  });

  it('extracts text from the Gemini shape', () => {
    const json = { candidates: [{ content: { parts: [{ text: '["c"]' }] } }] };
    expect(extractText('gemini', json)).toBe('["c"]');
  });

  it('throws when the shape is unexpected', () => {
    expect(() => extractText('groq', {})).toThrow();
    expect(() => extractText('gemini', {})).toThrow();
  });
});

describe('parseHookAndOutline', () => {
  it('parses a hook + outline object', () => {
    const raw = '{"hook":"Why X breaks","outline":["The problem","A cause","The fix"]}';
    expect(parseHookAndOutline(raw, 3)).toEqual({
      hook: 'Why X breaks',
      outline: ['The problem', 'A cause', 'The fix'],
    });
  });

  it('strips code fences before parsing', () => {
    const raw = '```json\n{"hook":"H","outline":["a","b"]}\n```';
    expect(parseHookAndOutline(raw, 2).outline).toEqual(['a', 'b']);
  });

  it('trims a too-long outline down to length', () => {
    const raw = '{"hook":"H","outline":["1","2","3","4","5"]}';
    expect(parseHookAndOutline(raw, 3).outline).toEqual(['1', '2', '3']);
  });

  it('keeps a short outline as-is (no empty padding)', () => {
    const raw = '{"hook":"H","outline":["only one"]}';
    expect(parseHookAndOutline(raw, 5).outline).toEqual(['only one']);
  });

  it('drops non-string and blank outline items', () => {
    const raw = '{"hook":"H","outline":["keep", 7, "  ", "also"]}';
    expect(parseHookAndOutline(raw, 5).outline).toEqual(['keep', 'also']);
  });

  it('throws when the hook is missing', () => {
    expect(() => parseHookAndOutline('{"outline":["a"]}', 3)).toThrow();
  });

  it('throws on unparseable output', () => {
    expect(() => parseHookAndOutline('not json at all', 3)).toThrow();
  });
});

describe('buildThreadPrompt', () => {
  it('builds a from-scratch prompt with no outline', () => {
    const { system, user } = buildThreadPrompt('AI agents', 'educational', 8);
    expect(system).toContain('Tweet 1 is the hook.');
    expect(system).not.toContain('Follow the given outline');
    expect(user).toContain('Topic: AI agents');
    expect(user).toContain('Number of tweets: 8');
    expect(user).not.toContain('Outline');
  });

  it('embeds the outline and the follow-outline instruction', () => {
    const { system, user } = buildThreadPrompt('AI agents', 'educational', 3, {
      outline: ['Point A', 'Point B', 'Point C'],
    });
    expect(system).toContain('Follow the given outline');
    expect(user).toContain('1. Point A');
    expect(user).toContain('3. Point C');
  });

  it('with a given firstTweet, lists the outline minus its first point', () => {
    const { system, user } = buildThreadPrompt('AI agents', 'educational', 3, {
      firstTweet: 'My hook',
      outline: ['Hook point', 'Point B', 'Point C'],
    });
    expect(system).toContain('Tweet 1 is already written');
    expect(user).toContain('Tweet 1 (already written): My hook');
    expect(user).toContain('Number of additional tweets to write: 2');
    expect(user).toContain('1. Point B');
    expect(user).toContain('2. Point C');
    expect(user).not.toContain('Hook point');
  });
});

describe('buildHookPrompt', () => {
  it('asks for a single hook tweet in the given tone', () => {
    const { system, user } = buildHookPrompt('AI agents', 'funny');
    expect(system).toContain('{"tweet": "..."}');
    expect(user).toContain('Topic: AI agents');
    expect(user).toContain(TONE_GUIDE.funny);
  });

  it('carries the language instruction', () => {
    const { system } = buildHookPrompt('AI agents', 'funny', 'vi');
    expect(system).toContain('in Vietnamese');
  });
});

describe('buildHookOutlinePrompt', () => {
  it('asks for a hook plus an outline sized to length', () => {
    const { system, user } = buildHookOutlinePrompt('AI agents', 'educational', 8);
    expect(system).toContain('{"hook": "...", "outline"');
    expect(system).toContain('outline has 8 short titles');
    expect(user).toContain('Topic: AI agents');
    expect(user).toContain(TONE_GUIDE.educational);
  });
});

describe('buildRegeneratePrompt', () => {
  it('numbers the thread and names the tweet to rewrite (1-based)', () => {
    const { system, user } = buildRegeneratePrompt(
      'AI agents', 'threadboi', ['tweet a', 'tweet b', 'tweet c'], 1,
    );
    expect(system).toContain('{"tweet": "..."}');
    expect(user).toContain('2. tweet b');
    expect(user).toContain('Rewrite tweet number 2.');
    expect(user).toContain(TONE_GUIDE.threadboi);
  });
});

describe('CRAFT_GUIDE wiring', () => {
  it('is present in all four builders\' system prompts', () => {
    expect(buildThreadPrompt('t', 'educational', 5).system).toContain(CRAFT_GUIDE);
    expect(buildHookPrompt('t', 'educational').system).toContain(CRAFT_GUIDE);
    expect(buildHookOutlinePrompt('t', 'educational', 5).system).toContain(CRAFT_GUIDE);
    expect(buildRegeneratePrompt('t', 'educational', ['a'], 0).system).toContain(CRAFT_GUIDE);
  });

  it('bans the classic AI tells and demands concrete detail', () => {
    expect(CRAFT_GUIDE).toContain("Let's dive in");
    expect(CRAFT_GUIDE).toContain('game-changer');
    expect(CRAFT_GUIDE).toContain('concrete detail');
  });
});

describe('ENDING_GUIDE wiring', () => {
  it('replaces the forced CTA ending in the thread prompt', () => {
    const { system } = buildThreadPrompt('t', 'educational', 5);
    expect(system).toContain(ENDING_GUIDE);
    expect(system).not.toContain('takeaway or CTA');
  });
});

describe('HOOK_GUIDE wiring', () => {
  it('is present in the three hook-producing builders', () => {
    expect(buildThreadPrompt('t', 'educational', 5).system).toContain(HOOK_GUIDE);
    expect(buildHookPrompt('t', 'educational').system).toContain(HOOK_GUIDE);
    expect(buildHookOutlinePrompt('t', 'educational', 5).system).toContain(HOOK_GUIDE);
  });

  it('is absent when tweet 1 is already written', () => {
    const { system } = buildThreadPrompt('t', 'educational', 5, { firstTweet: 'done' });
    expect(system).not.toContain(HOOK_GUIDE);
  });
});

describe('TONE_GUIDE personas', () => {
  it('describes each tone as a multi-sentence persona', () => {
    for (const tone of ['educational', 'funny', 'threadboi'] as const) {
      expect(TONE_GUIDE[tone].split('.').length).toBeGreaterThan(2);
    }
    expect(TONE_GUIDE.educational).toContain('practitioner');
    expect(TONE_GUIDE.funny).toContain('comedy');
    expect(TONE_GUIDE.threadboi).toContain('🧵');
  });
});

describe('TONE_EXEMPLARS wiring', () => {
  it('embeds only the selected tone\'s exemplar in the thread prompt', () => {
    const { user } = buildThreadPrompt('t', 'educational', 5);
    expect(user).toContain(TONE_EXEMPLARS.educational[0]);
    expect(user).toContain(TONE_EXEMPLARS.educational[2]);
    expect(user).not.toContain(TONE_EXEMPLARS.funny[0]);
    expect(user).toContain('copy the voice, not the content');
  });

  it('hook builders embed the exemplar\'s first tweet only', () => {
    const { user } = buildHookPrompt('t', 'threadboi');
    expect(user).toContain(TONE_EXEMPLARS.threadboi[0]);
    expect(user).not.toContain(TONE_EXEMPLARS.threadboi[1]);
    const outlinePrompt = buildHookOutlinePrompt('t', 'threadboi', 5);
    expect(outlinePrompt.user).toContain(TONE_EXEMPLARS.threadboi[0]);
  });

  it('has exactly three tweets per tone, each under 280 chars', () => {
    for (const tone of ['educational', 'funny', 'threadboi'] as const) {
      expect(TONE_EXEMPLARS[tone]).toHaveLength(3);
      for (const t of TONE_EXEMPLARS[tone]) expect(t.length).toBeLessThanOrEqual(280);
    }
  });
});
