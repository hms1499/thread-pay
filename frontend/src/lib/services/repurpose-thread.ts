import { TONES, LENGTHS, LANGUAGE_CODES, PRICE_STX, PRICE_SBTC, type Tone, type LanguageCode } from '@/lib/config';
import {
  resolveLlmConfig, assertApiKey, callLlm, parseThreadJson, parseHook, parseHookAndOutline, languageInstruction, TONE_GUIDE, CRAFT_GUIDE, ENDING_GUIDE,
} from '@/lib/generate-thread';
import type { ServiceDef, GenCtx, ValidateResult, PreviewResult } from './types';

export type RepurposeParams = { sourceText: string; tone: Tone; length: 5 | 8 | 12; language: LanguageCode };

export function buildRepurposeSystem(
  length: number, language: LanguageCode, outline?: string[] | null,
): string {
  const parts = [
    'You are an expert X (Twitter) thread writer.',
    CRAFT_GUIDE,
    'You are given a long source text. Distill it into a thread that captures its key points.',
    'Return ONLY a JSON object of the form {"tweets": ["...", "..."]} — one string per tweet.',
    'No markdown fences, no commentary, no numbering prefixes.',
    'Tweet 1 must be a strong hook.',
    ENDING_GUIDE,
    `Write about ${length} tweets. Each tweet must be under 270 characters.`,
  ];
  if (outline && outline.length) {
    parts.push(
      `Follow this outline, one tweet per point in order: ${outline.map((o, i) => `${i + 1}. ${o}`).join(' ')}.`,
    );
  }
  parts.push(languageInstruction(language));
  return parts.join(' ');
}

function validate(raw: unknown): ValidateResult<RepurposeParams> {
  const b = (raw ?? {}) as Record<string, unknown>;
  const sourceText = typeof b.sourceText === 'string' ? b.sourceText.trim() : '';
  const tone = b.tone as Tone;
  const length = Number(b.length);
  const language = (LANGUAGE_CODES as readonly string[]).includes(b.language as string)
    ? (b.language as LanguageCode) : 'auto';
  if (!sourceText || sourceText.length > 4000) return { ok: false, error: 'sourceText is required (max 4000 chars)' };
  if (!TONES.includes(tone) || !LENGTHS.includes(length as 5 | 8 | 12)) {
    return { ok: false, error: 'invalid tone or length' };
  }
  return { ok: true, params: { sourceText, tone, length: length as 5 | 8 | 12, language } };
}

async function generate(p: RepurposeParams, ctx: GenCtx): Promise<string[]> {
  const config = resolveLlmConfig(process.env);
  assertApiKey(config);
  const head = ctx.previewHook && ctx.previewHook.trim() !== '' ? [ctx.previewHook] : [];
  const want = head.length ? p.length - 1 : p.length;
  const restOutline = ctx.previewOutline ? ctx.previewOutline.slice(head.length) : null;
  const system = buildRepurposeSystem(want, p.language, restOutline);
  const user = `Source text:\n${p.sourceText}\nStyle: ${TONE_GUIDE[p.tone]}`;
  const rest = parseThreadJson(await callLlm(config, system, user));
  return [...head, ...rest].slice(0, p.length);
}

async function generatePreview(p: RepurposeParams): Promise<PreviewResult> {
  const config = resolveLlmConfig(process.env);
  assertApiKey(config);
  const system = [
    'You are an expert X (Twitter) thread writer.',
    CRAFT_GUIDE,
    `Read the source text and return ONLY {"hook":"...","outline":["...","..."]} for a ${p.length}-tweet thread that distills it.`,
    'hook is the opening tweet, under 270 characters.',
    `outline has ${p.length} short titles (max 8 words each), one per tweet in order; outline[0] summarizes the hook.`,
    'No fences, no commentary.',
    languageInstruction(p.language),
  ].join(' ');
  const r = parseHookAndOutline(
    await callLlm(config, system, `Source text:\n${p.sourceText}\nStyle: ${TONE_GUIDE[p.tone]}`),
    p.length,
  );
  return { hook: r.hook, outline: r.outline };
}

async function regenerateOne(p: RepurposeParams, thread: string[], i: number): Promise<string> {
  const config = resolveLlmConfig(process.env);
  assertApiKey(config);
  const system = [
    'You are an expert X (Twitter) thread writer.',
    CRAFT_GUIDE,
    'You are given a thread distilled from a source text and the 1-based position of ONE tweet to rewrite.',
    'Return ONLY {"tweet": "..."} — just the rewritten tweet. Keep the others as-is.',
    'Under 270 characters. No numbering prefixes, no commentary, no fences.',
    languageInstruction(p.language),
  ].join(' ');
  const numbered = thread.map((t, idx) => `${idx + 1}. ${t}`).join('\n');
  const user = `Source text:\n${p.sourceText}\nStyle: ${TONE_GUIDE[p.tone]}\nThread:\n${numbered}\n\nRewrite tweet number ${i + 1}.`;
  return parseHook(await callLlm(config, system, user));
}

export const repurposeThreadService: ServiceDef<RepurposeParams> = {
  id: 'repurpose-thread',
  label: 'Repurpose → Thread',
  blurb: 'Paste an article or notes; get a distilled X thread.',
  chained: true,
  priceStx: PRICE_STX,
  priceSbtc: PRICE_SBTC,
  fields: [
    { name: 'sourceText', type: 'textarea', label: 'Source text', placeholder: 'Paste the article or notes…', maxLen: 4000, required: true },
    { name: 'tone', type: 'select', label: 'Tone', default: 'educational', options: TONES.map((t) => ({ value: t, label: t })) },
    { name: 'length', type: 'number', label: 'Length', default: 8, options: [...LENGTHS] },
    { name: 'language', type: 'select', label: 'Language', default: 'auto',
      options: [{ value: 'auto', label: 'Auto' }, { value: 'en', label: 'English' }, { value: 'vi', label: 'Tiếng Việt' },
        { value: 'es', label: 'Español' }, { value: 'fr', label: 'Français' }, { value: 'ja', label: '日本語' }, { value: 'zh', label: '中文' }] },
  ],
  validate, generatePreview, generate, regenerateOne,
};
