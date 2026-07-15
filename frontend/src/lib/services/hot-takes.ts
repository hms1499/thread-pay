import { TONES, LANGUAGE_CODES, PRICE_STX, PRICE_SBTC, type Tone, type LanguageCode } from '@/lib/config';
import {
  resolveLlmConfig, assertApiKey, callLlm, parseThreadJson, parseHook, languageInstruction, TONE_GUIDE, CRAFT_GUIDE,
} from '@/lib/generate-thread';
import type { ServiceDef, GenCtx, ValidateResult, PreviewResult } from './types';

export type HotTakesParams = { topic: string; tone: Tone; count: 3 | 5 | 8; language: LanguageCode };
const COUNTS = [3, 5, 8] as const;

export function buildHotTakesSystem(count: number, language: LanguageCode): string {
  return [
    'You are a sharp X (Twitter) writer known for bold, standalone takes.',
    CRAFT_GUIDE,
    `Return ONLY a JSON object {"tweets": ["...", "..."]} with exactly ${count} items.`,
    'Each item is an INDEPENDENT, standalone post — NOT a numbered thread, no "1/n", no references to the others.',
    'Each must be under 270 characters, punchy, and provocative but defensible.',
    languageInstruction(language),
  ].join(' ');
}

function validate(raw: unknown): ValidateResult<HotTakesParams> {
  const b = (raw ?? {}) as Record<string, unknown>;
  const topic = typeof b.topic === 'string' ? b.topic.trim() : '';
  const tone = b.tone as Tone;
  const count = Number(b.count);
  const language = (LANGUAGE_CODES as readonly string[]).includes(b.language as string)
    ? (b.language as LanguageCode) : 'auto';
  if (!topic || topic.length > 300) return { ok: false, error: 'topic is required (max 300 chars)' };
  if (!TONES.includes(tone)) return { ok: false, error: 'invalid tone' };
  if (!(COUNTS as readonly number[]).includes(count)) return { ok: false, error: 'count must be 3, 5, or 8' };
  return { ok: true, params: { topic, tone, count: count as 3 | 5 | 8, language } };
}

async function generate(p: HotTakesParams, ctx: GenCtx): Promise<string[]> {
  const config = resolveLlmConfig(process.env);
  assertApiKey(config);
  const head = ctx.previewHook && ctx.previewHook.trim() !== '' ? [ctx.previewHook] : [];
  const want = head.length ? p.count - 1 : p.count;
  const system = buildHotTakesSystem(want, p.language);
  const rest = parseThreadJson(await callLlm(config, system, `Topic: ${p.topic}\nStyle: ${TONE_GUIDE[p.tone]}`));
  return [...head, ...rest].slice(0, p.count);
}

async function generatePreview(p: HotTakesParams): Promise<PreviewResult> {
  const config = resolveLlmConfig(process.env);
  assertApiKey(config);
  const system = [
    'You are a sharp X (Twitter) writer known for bold takes.',
    CRAFT_GUIDE,
    'Return ONLY {"tweet": "..."} — a single standalone hot take on the topic. Under 270 characters. No fences.',
    languageInstruction(p.language),
  ].join(' ');
  const hook = parseHook(await callLlm(config, system, `Topic: ${p.topic}\nStyle: ${TONE_GUIDE[p.tone]}`));
  return { hook, outline: null };
}

async function regenerateOne(p: HotTakesParams, thread: string[], i: number): Promise<string> {
  const config = resolveLlmConfig(process.env);
  assertApiKey(config);
  const system = [
    'You are a sharp X (Twitter) writer known for bold, standalone takes.',
    CRAFT_GUIDE,
    'Rewrite ONE take so it stays standalone and distinct from the others. Return ONLY {"tweet": "..."}.',
    'Under 270 characters. No numbering, no commentary, no fences.',
    languageInstruction(p.language),
  ].join(' ');
  const others = thread.filter((_, idx) => idx !== i).map((t) => `- ${t}`).join('\n');
  return parseHook(await callLlm(config, system, `Topic: ${p.topic}\nStyle: ${TONE_GUIDE[p.tone]}\nOther takes:\n${others}\n\nWrite a fresh take to replace number ${i + 1}.`));
}

export const hotTakesService: ServiceDef<HotTakesParams> = {
  id: 'hot-takes',
  label: 'Hot-takes Pack',
  blurb: 'One topic → a pack of bold standalone posts.',
  chained: false,
  priceStx: PRICE_STX,
  priceSbtc: PRICE_SBTC,
  fields: [
    { name: 'topic', type: 'text', label: 'Topic', placeholder: 'What do you have takes about?', maxLen: 300, required: true },
    { name: 'tone', type: 'select', label: 'Tone', default: 'threadboi', options: TONES.map((t) => ({ value: t, label: t })) },
    { name: 'count', type: 'number', label: 'How many', default: 5, options: [...COUNTS] },
    { name: 'language', type: 'select', label: 'Language', default: 'auto',
      options: [{ value: 'auto', label: 'Auto' }, { value: 'en', label: 'English' }, { value: 'vi', label: 'Tiếng Việt' },
        { value: 'es', label: 'Español' }, { value: 'fr', label: 'Français' }, { value: 'ja', label: '日本語' }, { value: 'zh', label: '中文' }] },
  ],
  validate, generatePreview, generate, regenerateOne,
};
