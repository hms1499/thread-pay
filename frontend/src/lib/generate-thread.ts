import { languageName, type Tone } from './config';

// Shared tone descriptions fed into LLM prompts. Exported so per-service prompt
// builders (x-thread, repurpose-thread, hot-takes) reuse one source of truth.
export const TONE_GUIDE: Record<Tone, string> = {
  educational: 'clear, informative, expert but approachable tone',
  funny: 'witty, meme-aware humor, still delivers real substance',
  threadboi: 'punchy growth-hacker style, bold hooks, strategic emoji (incl. 🧵)',
};

// Shared writing-craft rules injected into every prompt. One string so tests can
// assert its presence and services can reuse it verbatim.
export const CRAFT_GUIDE = [
  'Write like a real person sharing hard-won experience, not a content marketer.',
  'Banned phrases and tells (never use them or close variants): "Let\'s dive in",',
  '"game-changer", "unlock the power", "In this thread", "Follow me for more",',
  '"Thread 👇", opening every tweet with an emoji.',
  'Every tweet must carry at least one concrete detail: a number, a real example,',
  'a named tool, or a step the reader can take today.',
  'Vary the rhythm — mix short punches with longer lines; never let two',
  'consecutive tweets share the same skeleton.',
].join(' ');

// How a thread should end. Replaces the old forced "takeaway or CTA" closer,
// which produced the same bolted-on final tweet every time.
export const ENDING_GUIDE =
  'End on the sharpest insight of the thread — a line that lingers. ' +
  'Add a call to action only if it arises naturally; never bolt one on.';

// The system-prompt line that controls output language. A known code forces that
// language; 'auto'/unknown/null defers to the topic's own language.
export function languageInstruction(language?: string | null): string {
  const name = languageName(language);
  return name
    ? `Write the entire thread in ${name}, regardless of the language of the topic.`
    : 'Write in the same language as the topic given by the user.';
}

// ── Provider abstraction ──────────────────────────────────────────────
// Switch LLM provider with just the LLM_PROVIDER env var (default: groq, free).
// Groq/OpenRouter/Ollama use the OpenAI chat-completions shape; Gemini is separate.

const PROVIDERS = ['groq', 'gemini', 'openrouter', 'ollama'] as const;
export type Provider = (typeof PROVIDERS)[number];

const DEFAULTS: Record<Provider, { baseUrl: string; model: string; keyEnv: string }> = {
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    keyEnv: 'GROQ_API_KEY',
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.0-flash',
    keyEnv: 'GEMINI_API_KEY',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    keyEnv: 'OPENROUTER_API_KEY',
  },
  ollama: {
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
    keyEnv: '', // local, no key needed
  },
};

export type LlmConfig = {
  provider: Provider;
  baseUrl: string;
  model: string;
  apiKey: string;
};

export function resolveLlmConfig(env: Record<string, string | undefined>): LlmConfig {
  const provider = (env.LLM_PROVIDER ?? 'groq').toLowerCase();
  if (!PROVIDERS.includes(provider as Provider)) {
    throw new Error(`Unknown LLM_PROVIDER "${provider}". Allowed: ${PROVIDERS.join(', ')}`);
  }
  const d = DEFAULTS[provider as Provider];
  return {
    provider: provider as Provider,
    baseUrl: env.LLM_BASE_URL ?? d.baseUrl,
    model: env.LLM_MODEL ?? d.model,
    apiKey: d.keyEnv ? (env[d.keyEnv] ?? '') : '',
  };
}

export function extractText(provider: Provider, json: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = json as any;
  if (provider === 'gemini') {
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string') throw new Error('Unexpected Gemini response shape');
    return text;
  }
  const text = j?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('Unexpected OpenAI-compatible response shape');
  return text;
}

export function assertApiKey(config: LlmConfig): void {
  if (config.provider !== 'ollama' && !config.apiKey) {
    throw new Error(
      `Missing API key for "${config.provider}". Set ${DEFAULTS[config.provider].keyEnv} in .env.local`,
    );
  }
}

export async function callLlm(config: LlmConfig, system: string, user: string): Promise<string> {
  if (config.provider === 'gemini') {
    const url = `${config.baseUrl}/models/${config.model}:generateContent?key=${config.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          maxOutputTokens: 2000,
          temperature: 0.8,
          responseMimeType: 'application/json',
        },
      }),
    });
    if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
    return extractText('gemini', await res.json());
  }

  // OpenAI-compatible: groq, openrouter, ollama
  // (handled here; gemini returned above)
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 2000,
      temperature: 0.8,
      // Groq & OpenRouter support OpenAI JSON mode; it forces syntactically valid
      // JSON. Ollama doesn't, and rejects unknown fields, so skip it there.
      ...(config.provider === 'groq' || config.provider === 'openrouter'
        ? { response_format: { type: 'json_object' } }
        : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${config.provider} API ${res.status}: ${await res.text()}`);
  return extractText(config.provider, await res.json());
}

// Pull the first balanced JSON value (array or object) out of surrounding prose,
// respecting string literals so brackets inside text don't trip the scan.
function extractJsonSlice(s: string): string | null {
  const start = s.search(/[[{]/);
  if (start === -1) return null;
  const open = s[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

export function parseThreadJson(raw: string): string[] {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();

  // LLMs often wrap the JSON in prose ("Sure! Here is..."). Try a direct parse
  // first, then fall back to extracting the first balanced JSON value.
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const slice = extractJsonSlice(cleaned);
    if (slice === null) throw new Error('LLM output is not valid JSON');
    try {
      parsed = JSON.parse(slice);
    } catch {
      throw new Error('LLM output is not valid JSON');
    }
  }

  // Accept an object wrapper like {"tweets":[...]} / {"thread":[...]} — what
  // JSON-mode responses return — as well as a bare array.
  let arr: unknown = parsed;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    arr = obj.tweets ?? obj.thread ?? obj.items
      ?? Object.values(obj).find((v) => Array.isArray(v));
  }

  if (!Array.isArray(arr) || !arr.every((t) => typeof t === 'string')) {
    throw new Error('LLM output is not a JSON array of strings');
  }
  return arr.map((t: string) =>
    t.length > 280 ? `${t.slice(0, 277)}...` : t,
  );
}

// Parse a single hook tweet from the LLM. Accepts a JSON array of one string,
// a {"tweet": "..."} / {"hook": "..."} object, or a bare quoted string.
export function parseHook(raw: string): string {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch {
    const slice = extractJsonSlice(cleaned);
    if (slice !== null) {
      try { value = JSON.parse(slice); } catch { value = cleaned; }
    } else {
      value = cleaned;
    }
  }
  let hook: unknown = value;
  if (Array.isArray(value)) hook = value[0];
  else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    hook = obj.tweet ?? obj.hook ?? Object.values(obj).find((v) => typeof v === 'string');
  }
  if (typeof hook !== 'string' || hook.trim() === '') {
    throw new Error('LLM hook output is not a usable string');
  }
  const trimmed = hook.trim();
  return trimmed.length > 280 ? `${trimmed.slice(0, 277)}...` : trimmed;
}

// Parse a hook + outline object for the pre-payment preview. Accepts
// {"hook"|"tweet": "...", "outline": ["...", ...]}, tolerant of code fences.
// The outline is trimmed to at most `length` items; short outlines are kept
// as-is (no empty padding — the UI renders only the rows that exist).
export function parseHookAndOutline(
  raw: string, length: number,
): { hook: string; outline: string[] } {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const slice = extractJsonSlice(cleaned);
    if (slice === null) throw new Error('LLM output is not valid JSON');
    parsed = JSON.parse(slice);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LLM output is not a hook+outline object');
  }
  const obj = parsed as Record<string, unknown>;
  const rawHook = typeof obj.hook === 'string' ? obj.hook
    : typeof obj.tweet === 'string' ? obj.tweet : '';
  const hook = rawHook.trim();
  if (!hook) throw new Error('LLM output is missing a usable hook');
  const items = (Array.isArray(obj.outline) ? obj.outline : [])
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, length);
  const cappedHook = hook.length > 280 ? `${hook.slice(0, 277)}...` : hook;
  return { hook: cappedHook, outline: items };
}

export function buildThreadPrompt(
  topic: string, tone: Tone, length: number,
  opts?: { firstTweet?: string | null; language?: string | null; outline?: string[] | null },
): { system: string; user: string } {
  const firstTweet = opts?.firstTweet && opts.firstTweet.trim() !== '' ? opts.firstTweet : null;
  const wanted = firstTweet ? length - 1 : length;
  // Tweet 1 is the hook; the remaining tweets follow the outline minus its first point.
  const full = opts?.outline && opts.outline.length ? opts.outline : null;
  const restOutline = full ? (firstTweet ? full.slice(1) : full) : null;
  const hasOutline = !!(restOutline && restOutline.length);
  const system = [
    'You are an expert X (Twitter) thread writer.',
    CRAFT_GUIDE,
    'Return ONLY a JSON object of the form {"tweets": ["...", "..."]} — one string per tweet.',
    'No markdown fences, no commentary, no numbering prefixes.',
    'Each tweet must be under 270 characters.',
    firstTweet
      ? 'Tweet 1 is already written (given below). Write ONLY the remaining tweets that continue it; do NOT repeat tweet 1.'
      : 'Tweet 1 must be a strong hook.',
    hasOutline
      ? 'Follow the given outline: write one tweet per outline point, in order, each tweet staying on its point.'
      : '',
    ENDING_GUIDE,
    languageInstruction(opts?.language),
  ].filter(Boolean).join(' ');
  const outlineBlock = hasOutline
    ? `\nOutline (one tweet per point, in order):\n${restOutline!.map((o, i) => `${i + 1}. ${o}`).join('\n')}`
    : '';
  const user = firstTweet
    ? `Topic: ${topic}\nTweet 1 (already written): ${firstTweet}\nNumber of additional tweets to write: ${wanted}\nStyle: ${TONE_GUIDE[tone]}${outlineBlock}`
    : `Topic: ${topic}\nNumber of tweets: ${length}\nStyle: ${TONE_GUIDE[tone]}${outlineBlock}`;
  return { system, user };
}

export function buildHookPrompt(
  topic: string, tone: Tone, language?: string | null,
): { system: string; user: string } {
  const system = [
    'You are an expert X (Twitter) thread writer.',
    CRAFT_GUIDE,
    'Return ONLY a JSON object of the form {"tweet": "..."} — a single opening hook tweet.',
    'No markdown fences, no commentary, no numbering.',
    'The tweet must be under 270 characters and be a strong, scroll-stopping hook.',
    languageInstruction(language),
  ].join(' ');
  const user = `Topic: ${topic}\nStyle: ${TONE_GUIDE[tone]}`;
  return { system, user };
}

// One free, cheap LLM call: just the opening hook tweet. Used at quote time.
export async function generateHook(topic: string, tone: Tone, language?: string | null): Promise<string> {
  const config = resolveLlmConfig(process.env);
  assertApiKey(config);
  const { system, user } = buildHookPrompt(topic, tone, language);
  const raw = await callLlm(config, system, user);
  return parseHook(raw);
}

export function buildHookOutlinePrompt(
  topic: string, tone: Tone, length: number, language?: string | null,
): { system: string; user: string } {
  const system = [
    'You are an expert X (Twitter) thread writer.',
    CRAFT_GUIDE,
    `Return ONLY a JSON object of the form {"hook": "...", "outline": ["...", "..."]} for a ${length}-tweet thread.`,
    'hook is the opening tweet — under 270 characters, scroll-stopping.',
    `outline has ${length} short titles (max 8 words each), one per tweet in order; outline[0] summarizes the hook.`,
    'No markdown fences, no commentary, no numbering prefixes.',
    languageInstruction(language),
  ].join(' ');
  const user = `Topic: ${topic}\nStyle: ${TONE_GUIDE[tone]}`;
  return { system, user };
}

// One LLM call producing the opening hook plus a short outline (one title per
// tweet). Used at quote time to power the pre-payment preview.
export async function generateHookAndOutline(
  topic: string, tone: Tone, length: number, language?: string | null,
): Promise<{ hook: string; outline: string[] }> {
  const config = resolveLlmConfig(process.env);
  assertApiKey(config);
  const { system, user } = buildHookOutlinePrompt(topic, tone, length, language);
  return parseHookAndOutline(await callLlm(config, system, user), length);
}

export function buildRegeneratePrompt(
  topic: string, tone: Tone, thread: string[], index: number, language?: string | null,
): { system: string; user: string } {
  const system = [
    'You are an expert X (Twitter) thread writer.',
    CRAFT_GUIDE,
    'You are given an existing thread and the 1-based position of ONE tweet to rewrite.',
    'Return ONLY a JSON object of the form {"tweet": "..."} — just the rewritten tweet.',
    'Rewrite ONLY that tweet so it still fits its place in the thread; keep the others as-is.',
    'It must be under 270 characters. No numbering prefixes, no commentary, no fences.',
    languageInstruction(language),
  ].join(' ');
  const numbered = thread.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const user = `Topic: ${topic}\nStyle: ${TONE_GUIDE[tone]}\nThread:\n${numbered}\n\nRewrite tweet number ${index + 1}.`;
  return { system, user };
}

// Rewrite a SINGLE tweet in place, given the whole thread for context. Returns the
// one replacement tweet (parseHook caps it at 280); the caller splices it back in.
export async function regenerateTweet(
  topic: string, tone: Tone, thread: string[], index: number,
  opts?: { language?: string | null },
): Promise<string> {
  const config = resolveLlmConfig(process.env);
  assertApiKey(config);
  const { system, user } = buildRegeneratePrompt(topic, tone, thread, index, opts?.language);
  const raw = await callLlm(config, system, user);
  return parseHook(raw);
}

// Combine an optional pinned first tweet with the model's continuation, capped at
// `length`. When firstTweet is null/empty, only the model's array is used.
export function assembleThread(
  firstTweet: string | null, rest: string[], length: number,
): string[] {
  const head = firstTweet ? [firstTweet] : [];
  return [...head, ...rest].slice(0, length);
}

export async function generateThread(
  topic: string, tone: Tone, length: number,
  opts?: { firstTweet?: string | null; language?: string | null; outline?: string[] | null },
): Promise<string[]> {
  const config = resolveLlmConfig(process.env);
  assertApiKey(config);
  const firstTweet = opts?.firstTweet && opts.firstTweet.trim() !== '' ? opts.firstTweet : null;
  const { system, user } = buildThreadPrompt(topic, tone, length, opts);
  const raw = await callLlm(config, system, user);
  const rest = parseThreadJson(raw);
  return assembleThread(firstTweet, rest, length);
}
