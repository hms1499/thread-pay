/**
 * Prompt/model eval matrix (dev-only).
 *
 * Runs {old frozen prompt, new live prompt} x {candidate Groq models} over a
 * fixed set of topic+tone pairs and writes eval-results.md (gitignored) for
 * side-by-side human grading. Old prompt is FROZEN here on purpose: later lib
 * changes must not corrupt the baseline.
 *
 *   npm run eval:prompts -- --dry-run          # print the matrix, no API calls
 *   npm run eval:prompts -- --pairs=1 --models=llama-3.3-70b-versatile
 *   npm run eval:prompts                        # full 8 x 2 x 4 = 64 runs
 */
import { writeFileSync } from 'node:fs';
import {
  buildThreadPrompt, callLlm, parseThreadJson, resolveLlmConfig, assertApiKey,
} from '../src/lib/generate-thread';
import type { Tone } from '../src/lib/config';

const MODELS = [
  'llama-3.3-70b-versatile',            // current default
  'openai/gpt-oss-120b',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'qwen/qwen3.6-27b',
];

type Pair = { topic: string; tone: Tone; length: number };
const PAIRS: Pair[] = [
  { topic: 'How to negotiate a raise as a software engineer', tone: 'educational', length: 8 },
  { topic: 'Bitcoin self-custody mistakes beginners make', tone: 'educational', length: 8 },
  { topic: 'Làm freelancer ở Việt Nam: bài học sau 3 năm', tone: 'educational', length: 8 },
  { topic: 'Why your side project will never launch', tone: 'funny', length: 5 },
  { topic: 'Chuyện dậy sớm lúc 5h sáng để thành công', tone: 'funny', length: 5 },
  { topic: 'I quit my job to build a one-person SaaS', tone: 'threadboi', length: 8 },
  { topic: 'Cách viết thread X ngàn like không cần follower', tone: 'threadboi', length: 5 },
  { topic: 'What remote work does to junior developers', tone: 'educational', length: 12 },
];

// ── Frozen baseline: the pre-overhaul prompt, verbatim ─────────────────
const OLD_TONE_GUIDE: Record<Tone, string> = {
  educational: 'clear, informative, expert but approachable tone',
  funny: 'witty, meme-aware humor, still delivers real substance',
  threadboi: 'punchy growth-hacker style, bold hooks, strategic emoji (incl. 🧵)',
};

function oldPrompt(p: Pair): { system: string; user: string } {
  const system = [
    'You are an expert X (Twitter) thread writer.',
    'Return ONLY a JSON object of the form {"tweets": ["...", "..."]} — one string per tweet.',
    'No markdown fences, no commentary, no numbering prefixes.',
    'Each tweet must be under 270 characters.',
    'Tweet 1 must be a strong hook.',
    'The last tweet wraps up with a takeaway or CTA.',
    'Write in the same language as the topic given by the user.',
  ].join(' ');
  const user = `Topic: ${p.topic}\nNumber of tweets: ${p.length}\nStyle: ${OLD_TONE_GUIDE[p.tone]}`;
  return { system, user };
}

// ── CLI ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const modelsArg = args.find((a) => a.startsWith('--models='))?.slice('--models='.length);
const pairsArg = args.find((a) => a.startsWith('--pairs='))?.slice('--pairs='.length);
const models = modelsArg ? modelsArg.split(',') : MODELS;
const pairs = pairsArg ? PAIRS.slice(0, Number(pairsArg)) : PAIRS;
const DELAY_MS = 2500; // free-tier rate limits

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runCell(
  model: string, variant: 'old' | 'new', p: Pair,
): Promise<string[]> {
  const base = resolveLlmConfig(process.env); // provider/key from env (groq)
  const config = { ...base, model };
  assertApiKey(config);
  const { system, user } = variant === 'old' ? oldPrompt(p) : buildThreadPrompt(p.topic, p.tone, p.length);
  return parseThreadJson(await callLlm(config, system, user));
}

async function main() {
  const total = pairs.length * models.length * 2;
  console.log(`matrix: ${pairs.length} pairs x ${models.length} models x 2 prompts = ${total} runs`);
  if (dryRun) {
    for (const p of pairs) for (const m of models) console.log(`- [${p.tone}/${p.length}] ${m} :: ${p.topic}`);
    return;
  }

  const lines: string[] = ['# Prompt eval results', '', `Generated ${new Date().toISOString()}`, ''];
  let done = 0;
  for (const p of pairs) {
    lines.push(`## ${p.topic}`, '', `tone: **${p.tone}**, length: ${p.length}`, '');
    for (const m of models) {
      for (const variant of ['old', 'new'] as const) {
        done++;
        process.stdout.write(`\r${done}/${total}  ${m} ${variant}          `);
        try {
          const tweets = await runCell(m, variant, p);
          lines.push(`### ${m} — ${variant.toUpperCase()}`, '', ...tweets.map((t, i) => `${i + 1}. ${t}`), '');
        } catch (e) {
          lines.push(`### ${m} — ${variant.toUpperCase()}`, '', `**ERROR:** ${(e as Error).message}`, '');
        }
        await sleep(DELAY_MS);
      }
    }
  }
  writeFileSync('eval-results.md', lines.join('\n'));
  console.log('\nwrote eval-results.md');
}

main().catch((e) => { console.error(e); process.exit(1); });
