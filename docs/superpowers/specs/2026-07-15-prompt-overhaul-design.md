# Prompt Overhaul + Model Eval — Design

**Date:** 2026-07-15
**Status:** Approved
**Scope:** `frontend/src/lib/generate-thread.ts` (prompt strings only) + new `frontend/scripts/eval-prompts.mjs`

## Problem

Real users report three quality failures in generated threads, all classic
symptoms of a thin system prompt on a mid-size model:

1. **Generic AI-speak** — "Let's dive in 🚀", "game-changer", forced closing CTA
   on every thread; reads machine-written.
2. **No depth/specificity** — tweets are empty slogans; no numbers, examples, or
   named tools.
3. **Weak hooks** — the opening tweet doesn't stop the scroll, despite a
   "scroll-stopping" instruction.

Current state: the system prompt in `buildThreadPrompt` is ~6 terse lines;
`TONE_GUIDE` is one line per tone; there are no few-shot examples, no
anti-AI-speak rules, and a mandatory CTA ending. Model is Groq
`llama-3.3-70b-versatile` (default), temperature 0.8.

## Non-goals

- No change to the output contract (`{"tweets":[...]}`, 270-char cap), parsing
  (`parseThreadJson`, `parseHook`, `parseHookAndOutline`), API schema, payment
  path, or pricing. This is a strings-only change plus a dev script.
- No two-pass draft→critique pipeline (possible later layer, out of scope).
- No provider change — stays provider-agnostic; model choice is env-only.

## Design

### 1. Prompt architecture (`generate-thread.ts`)

Extract the writing craft into shared constants consumed by all four prompt
builders (`buildThreadPrompt`, `generateHook`, `generateHookAndOutline`,
`regenerateTweet`):

- **`CRAFT_GUIDE`** — shared writing rules:
  - Write like a real person sharing hard-won experience, not a content
    marketer.
  - Banned-phrase list: "Let's dive in", "game-changer", "unlock", "Follow me
    for more", "In this thread", leading emoji on every tweet, and similar
    AI-tells.
  - Every tweet must carry at least one concrete detail: a number, a real
    example, a named tool, or an immediately actionable step.
  - Vary sentence rhythm across tweets; no template repetition.
- **`HOOK_GUIDE`** — four hook patterns the model must choose from: shocking
  number / contrarian claim against the majority view / story opened
  mid-action / measurable-outcome promise. Used by all three hook-producing
  builders.
- **`TONE_GUIDE` upgrade** — each tone becomes a 3–4 sentence persona, plus one
  mini exemplar thread (3 tweets) per tone as a few-shot sample. Only the
  selected tone's persona + exemplar is included in a given call (token
  control).
- **Ending rule** — replace "The last tweet wraps up with a takeaway or CTA"
  with: end on the sharpest insight; add a CTA only when it feels natural.

Existing behaviors preserved: `firstTweet` continuation mode, outline-following
mode, `languageInstruction`, JSON-format instructions, per-tweet char cap.

### 2. Eval script (`frontend/scripts/eval-prompts.mjs`)

- 8 fixed topic+tone pairs (mixed English/Vietnamese; niches: dev, crypto,
  lifestyle, career...).
- Matrix run: {old prompt, new prompt} × {candidate models}. The **old prompt
  is frozen inline in the script** as the permanent baseline, so later lib
  changes don't corrupt comparisons. The new prompt is imported from the lib.
- Candidate models (verified available on the project's Groq key,
  2026-07-15): `llama-3.3-70b-versatile` (current), `openai/gpt-oss-120b`,
  `meta-llama/llama-4-scout-17b-16e-instruct`, `qwen/qwen3.6-27b`.
- Sequential execution with delay (free-tier rate limits). Output:
  `eval-results.md` (gitignored), side-by-side per topic for human judgment.
  No LLM-judge — 64 outputs are eyeballable in minutes and human judgment is
  the point.

### 3. Model selection

After the user grades the eval output, the winning model is set via
`LLM_MODEL` in `.env.local` and Vercel env. Zero code change; instant rollback
by unsetting the var.

### 4. Testing & verification

- Entire existing vitest suite must pass unchanged (parsing contract
  untouched).
- New unit tests for the prompt builders: selected tone pulls its exemplar;
  ban list present in system prompt; firstTweet/outline modes still compose
  correctly.
- Final verification: run the eval script for real; one end-to-end generate on
  testnet.

## Risks

- Few-shot exemplars grow input tokens per call — bounded by including only
  the selected tone's exemplar (~150 extra tokens).
- `qwen3.6` emits thinking prefixes in some modes — JSON mode +
  `extractJsonSlice` fallback already tolerate surrounding prose; eval will
  confirm per model.
- Prompt changes can regress unpredictably per language — the eval set mixes
  Vietnamese and English topics to catch this before shipping.
