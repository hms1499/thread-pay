# Prompt Overhaul + Model Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite ThreadGogh's LLM prompts to kill AI-speak, force concrete detail, and teach hook patterns — then pick the best free Groq model via a side-by-side eval script.

**Architecture:** All prompt text lives in `frontend/src/lib/generate-thread.ts` as exported constants (`CRAFT_GUIDE`, `HOOK_GUIDE`, `ENDING_GUIDE`, upgraded `TONE_GUIDE`, new `TONE_EXEMPLARS`) consumed by pure prompt-builder functions. The two other services (`hot-takes`, `repurpose-thread`) import the same constants. A dev-only script `scripts/eval-prompts.ts` (run via tsx) compares a frozen copy of the old prompt against the live new one across Groq models and writes a gitignored markdown report for human grading.

**Tech Stack:** TypeScript 5, Vitest 4, tsx (new devDependency, dev-only), Groq API (existing `callLlm`).

**Spec:** `docs/superpowers/specs/2026-07-15-prompt-overhaul-design.md`

## Global Constraints

- Run all frontend commands from `frontend/`. Tests: `npm test` (vitest run). Lint: `npm run lint`.
- **Output contract unchanged:** `{"tweets":[...]}` / `{"tweet":"..."}` / `{"hook":"...","outline":[...]}` JSON shapes, 270-char instruction, 280-char parse cap, and all parsing functions (`parseThreadJson`, `parseHook`, `parseHookAndOutline`) stay byte-identical.
- **Never touch:** payment path, API route schemas, `lib/supabase.ts`, pricing, contracts.
- Commit directly on `main`, one commit per task, **no Co-Authored-By trailer**.
- Full vitest suite must pass before every commit.
- The app is live on mainnet; nothing in this plan requires a deploy decision — prompts ship with the next normal deploy.

---

### Task 1: Extract pure prompt builders for hook, hook+outline, regenerate

`generateHook`, `generateHookAndOutline`, and `regenerateTweet` build their system/user prompts inline inside async LLM-calling functions, so prompt content is untestable. Extract pure builders (same pattern as the existing `buildThreadPrompt`). Zero behavior change.

**Files:**
- Modify: `frontend/src/lib/generate-thread.ts:292-346`
- Test: `frontend/src/lib/__tests__/generate-thread.test.ts`

**Interfaces:**
- Produces (later tasks and tests rely on these exact signatures):
  - `buildHookPrompt(topic: string, tone: Tone, language?: string | null): { system: string; user: string }`
  - `buildHookOutlinePrompt(topic: string, tone: Tone, length: number, language?: string | null): { system: string; user: string }`
  - `buildRegeneratePrompt(topic: string, tone: Tone, thread: string[], index: number, language?: string | null): { system: string; user: string }`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/__tests__/generate-thread.test.ts` (add `buildHookPrompt, buildHookOutlinePrompt, buildRegeneratePrompt, TONE_GUIDE` to the import on line 2):

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/__tests__/generate-thread.test.ts`
Expected: FAIL — `buildHookPrompt is not a function` (not exported).

- [ ] **Step 3: Extract the builders**

In `frontend/src/lib/generate-thread.ts`, replace the bodies of the three async functions so each inline prompt moves into an exported pure builder placed just above its consumer. The prompt strings are copied **verbatim** — no wording changes in this task:

```ts
export function buildHookPrompt(
  topic: string, tone: Tone, language?: string | null,
): { system: string; user: string } {
  const system = [
    'You are an expert X (Twitter) thread writer.',
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
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS (all files — services import from this module).

- [ ] **Step 5: Commit**

```bash
git add src/lib/generate-thread.ts src/lib/__tests__/generate-thread.test.ts
git commit -m "refactor(llm): extract pure prompt builders for hook, outline, regenerate"
```

---

### Task 2: CRAFT_GUIDE — ban AI-speak, require concrete detail

**Files:**
- Modify: `frontend/src/lib/generate-thread.ts` (constant near `TONE_GUIDE`; the four builders)
- Test: `frontend/src/lib/__tests__/generate-thread.test.ts`

**Interfaces:**
- Produces: `export const CRAFT_GUIDE: string` — consumed by Tasks 7–8 (services) and present in every system prompt of the four builders.

- [ ] **Step 1: Write the failing tests**

Append (add `CRAFT_GUIDE` to the test-file import):

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/__tests__/generate-thread.test.ts`
Expected: FAIL — `CRAFT_GUIDE` not exported.

- [ ] **Step 3: Add the constant and wire it**

Insert after the `TONE_GUIDE` block in `generate-thread.ts`:

```ts
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
```

Then in each of the four builders, insert `CRAFT_GUIDE,` as the second element of the `system` array, directly after `'You are an expert X (Twitter) thread writer.',`.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/generate-thread.ts src/lib/__tests__/generate-thread.test.ts
git commit -m "feat(llm): craft guide — ban AI-speak, require concrete detail"
```

---

### Task 3: ENDING_GUIDE — drop the forced CTA

**Files:**
- Modify: `frontend/src/lib/generate-thread.ts` (constant + `buildThreadPrompt`)
- Test: `frontend/src/lib/__tests__/generate-thread.test.ts`

**Interfaces:**
- Produces: `export const ENDING_GUIDE: string` — reused by Task 8 (repurpose service).

- [ ] **Step 1: Write the failing test**

Append (add `ENDING_GUIDE` to the import):

```ts
describe('ENDING_GUIDE wiring', () => {
  it('replaces the forced CTA ending in the thread prompt', () => {
    const { system } = buildThreadPrompt('t', 'educational', 5);
    expect(system).toContain(ENDING_GUIDE);
    expect(system).not.toContain('takeaway or CTA');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/__tests__/generate-thread.test.ts`
Expected: FAIL — `ENDING_GUIDE` not exported.

- [ ] **Step 3: Add the constant and swap the line**

Insert after `CRAFT_GUIDE`:

```ts
// How a thread should end. Replaces the old forced "takeaway or CTA" closer,
// which produced the same bolted-on final tweet every time.
export const ENDING_GUIDE =
  'End on the sharpest insight of the thread — a line that lingers. ' +
  'Add a call to action only if it arises naturally; never bolt one on.';
```

In `buildThreadPrompt`, replace the line:

```ts
    'The last tweet wraps up with a takeaway or CTA.',
```

with:

```ts
    ENDING_GUIDE,
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/generate-thread.ts src/lib/__tests__/generate-thread.test.ts
git commit -m "feat(llm): end threads on the sharpest insight, not a forced CTA"
```

---

### Task 4: HOOK_GUIDE — four hook patterns for every hook-producing prompt

**Files:**
- Modify: `frontend/src/lib/generate-thread.ts` (constant; `buildThreadPrompt`, `buildHookPrompt`, `buildHookOutlinePrompt`)
- Test: `frontend/src/lib/__tests__/generate-thread.test.ts` (new tests + update one existing assertion)

**Interfaces:**
- Produces: `export const HOOK_GUIDE: string`.

- [ ] **Step 1: Write the failing tests and update the stale one**

Append (add `HOOK_GUIDE` to the import):

```ts
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
```

In the existing `buildThreadPrompt` describe block, the first test asserts the old wording. Change:

```ts
    expect(system).toContain('Tweet 1 must be a strong hook.');
```

to:

```ts
    expect(system).toContain('Tweet 1 is the hook.');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/__tests__/generate-thread.test.ts`
Expected: FAIL — `HOOK_GUIDE` not exported.

- [ ] **Step 3: Add the constant and wire it**

Insert after `ENDING_GUIDE`:

```ts
// Hook construction patterns. Injected wherever a prompt asks the model to
// write tweet 1 from scratch (not when the hook is already written).
export const HOOK_GUIDE = [
  'Build the hook on one of these patterns (pick the strongest for the topic):',
  'a specific surprising number; a claim that contradicts what most people',
  'believe; a story that opens mid-action; or a promise of a concrete,',
  'measurable outcome.',
  'Never open with a greeting, a definition, or an announcement that a thread follows.',
].join(' ');
```

In `buildThreadPrompt`, replace:

```ts
      : 'Tweet 1 must be a strong hook.',
```

with:

```ts
      : `Tweet 1 is the hook. ${HOOK_GUIDE}`,
```

In `buildHookPrompt`, replace:

```ts
    'The tweet must be under 270 characters and be a strong, scroll-stopping hook.',
```

with:

```ts
    `The tweet must be under 270 characters. ${HOOK_GUIDE}`,
```

In `buildHookOutlinePrompt`, replace:

```ts
    'hook is the opening tweet — under 270 characters, scroll-stopping.',
```

with:

```ts
    `hook is the opening tweet — under 270 characters. ${HOOK_GUIDE}`,
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/generate-thread.ts src/lib/__tests__/generate-thread.test.ts
git commit -m "feat(llm): hook-pattern guide for every from-scratch hook prompt"
```

---

### Task 5: TONE_GUIDE personas

One-line tone hints become 3–4 sentence personas. `TONE_GUIDE` is already interpolated as `Style: ${TONE_GUIDE[tone]}` in every user prompt (including the hot-takes and repurpose services), so this task is constant-only — no builder changes.

**Files:**
- Modify: `frontend/src/lib/generate-thread.ts:5-9`
- Test: `frontend/src/lib/__tests__/generate-thread.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/__tests__/generate-thread.test.ts`
Expected: FAIL — current one-liners have ≤2 sentence segments and lack the marker words.

- [ ] **Step 3: Replace the constant**

```ts
// Shared tone personas fed into LLM prompts as `Style: ...`. Exported so
// per-service prompt builders (x-thread, repurpose-thread, hot-takes) reuse
// one source of truth.
export const TONE_GUIDE: Record<Tone, string> = {
  educational:
    'a practitioner who has actually done the thing, teaching it plainly. ' +
    'Clear, informative, expert but approachable. Prefers numbers and named tools ' +
    'over adjectives. Explains why before how, and never talks down to the reader.',
  funny:
    'a sharp comedy writer who genuinely knows the subject. Witty and meme-aware, ' +
    'self-deprecating where it lands. Every joke smuggles in a real insight — ' +
    'humor is the delivery, substance is the payload. Punchlines sit at tweet ends.',
  threadboi:
    'a growth-hacker who actually ships. Punchy, bold, confident, short lines. ' +
    'Strategic emoji (incl. 🧵) but never emoji soup. Every big claim is backed ' +
    'by a specific number or example in the same tweet. Writes hooks people screenshot.',
};
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS (services tests interpolate whatever the constant holds; nothing asserts the old one-liners — if one does, update its expectation to reference `TONE_GUIDE[tone]` instead of a literal).

- [ ] **Step 5: Commit**

```bash
git add src/lib/generate-thread.ts src/lib/__tests__/generate-thread.test.ts
git commit -m "feat(llm): tone personas replace one-line tone hints"
```

---

### Task 6: TONE_EXEMPLARS — few-shot voice samples

One 3-tweet exemplar per tone. The full-thread builder shows the whole exemplar; the two hook builders show only its first tweet as an example hook. Only the selected tone's exemplar is ever included (~150 tokens).

**Files:**
- Modify: `frontend/src/lib/generate-thread.ts` (new constant; `buildThreadPrompt`, `buildHookPrompt`, `buildHookOutlinePrompt`)
- Test: `frontend/src/lib/__tests__/generate-thread.test.ts`

**Interfaces:**
- Produces: `export const TONE_EXEMPLARS: Record<Tone, string[]>` (exactly 3 strings per tone).

- [ ] **Step 1: Write the failing tests**

Append (add `TONE_EXEMPLARS` to the import):

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/__tests__/generate-thread.test.ts`
Expected: FAIL — `TONE_EXEMPLARS` not exported.

- [ ] **Step 3: Add the constant and wire it**

Insert after `TONE_GUIDE`:

```ts
// One mini exemplar thread per tone, used as a few-shot voice sample. Only the
// selected tone's exemplar goes into a prompt. Deliberately about topics users
// are unlikely to request, so the model copies the voice, not the content.
export const TONE_EXEMPLARS: Record<Tone, string[]> = {
  educational: [
    'We cut production incidents 40% in one quarter. No new tools — one habit change: every PR under 200 lines.',
    'Big PRs hide bugs. Reviewer attention fades after ~10 minutes, so a 1,000-line diff gets rubber-stamped. Split by behavior, not by file count.',
    'Try it tomorrow: take your current branch and ship the smallest slice that works on its own. You merge faster and review better.',
  ],
  funny: [
    "Our daily standup is 15 minutes. 14 of them are one guy explaining why Jira is wrong.",
    "We tried async standups for a month. Turns out 'no blockers 👍' typed at 9:02 means exactly what it means spoken at 9:02 — nothing.",
    "The fix was embarrassing: only meet when someone is actually blocked. Meetings dropped 80%. The work didn't notice.",
  ],
  threadboi: [
    'My side project made $4,200 last month. It made $0 for the 11 months before that. What actually moved the needle 🧵',
    'I stopped building features. I put the 5 questions every buyer asked straight onto the landing page. Conversion went 0.8% → 2.1%.',
    'Ship the boring stuff: pricing page, FAQ, refund policy. Trust converts better than features.',
  ],
};
```

In `buildThreadPrompt`, add an exemplar block and append it to both user-string branches:

```ts
  const exemplarBlock =
    `\nExample thread in this style (different topic — copy the voice, not the content):\n` +
    TONE_EXEMPLARS[tone].map((t, i) => `${i + 1}. ${t}`).join('\n');
  const user = firstTweet
    ? `Topic: ${topic}\nTweet 1 (already written): ${firstTweet}\nNumber of additional tweets to write: ${wanted}\nStyle: ${TONE_GUIDE[tone]}${outlineBlock}${exemplarBlock}`
    : `Topic: ${topic}\nNumber of tweets: ${length}\nStyle: ${TONE_GUIDE[tone]}${outlineBlock}${exemplarBlock}`;
```

In `buildHookPrompt` and `buildHookOutlinePrompt`, change the user string to:

```ts
  const user = `Topic: ${topic}\nStyle: ${TONE_GUIDE[tone]}\nExample hook in this style (different topic — copy the voice, not the content): "${TONE_EXEMPLARS[tone][0]}"`;
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/generate-thread.ts src/lib/__tests__/generate-thread.test.ts
git commit -m "feat(llm): per-tone few-shot exemplars"
```

---

### Task 7: Wire CRAFT_GUIDE into the hot-takes service

**Files:**
- Modify: `frontend/src/lib/services/hot-takes.ts` (`buildHotTakesSystem` + the two inline systems in `generatePreview`/`regenerateOne`)
- Test: `frontend/src/lib/services/__tests__/hot-takes.test.ts`

**Interfaces:**
- Consumes: `CRAFT_GUIDE` from `@/lib/generate-thread` (Task 2).

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/services/__tests__/hot-takes.test.ts`:

```ts
import { CRAFT_GUIDE } from '@/lib/generate-thread';
import { buildHotTakesSystem } from '../hot-takes';

describe('buildHotTakesSystem craft rules', () => {
  it('includes the shared craft guide', () => {
    expect(buildHotTakesSystem(5, 'auto')).toContain(CRAFT_GUIDE);
  });
});
```

(If the file already imports `buildHotTakesSystem`, merge into the existing import instead of duplicating.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/services/__tests__/hot-takes.test.ts`
Expected: FAIL — craft guide not in the system prompt.

- [ ] **Step 3: Wire it**

In `frontend/src/lib/services/hot-takes.ts`: add `CRAFT_GUIDE` to the import from `@/lib/generate-thread`, then insert `CRAFT_GUIDE,` as the second array element in all three system prompts — `buildHotTakesSystem` (after the `'You are a sharp X (Twitter) writer known for bold, standalone takes.'` line) and the inline arrays in `generatePreview` and `regenerateOne` (after their role lines).

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/hot-takes.ts src/lib/services/__tests__/hot-takes.test.ts
git commit -m "feat(hot-takes): apply the shared craft guide"
```

---

### Task 8: Wire CRAFT_GUIDE + ENDING_GUIDE into the repurpose service

**Files:**
- Modify: `frontend/src/lib/services/repurpose-thread.ts` (`buildRepurposeSystem` + inline systems in `generatePreview`/`regenerateOne`)
- Test: `frontend/src/lib/services/__tests__/repurpose-thread.test.ts`

**Interfaces:**
- Consumes: `CRAFT_GUIDE` (Task 2), `ENDING_GUIDE` (Task 3).

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/services/__tests__/repurpose-thread.test.ts`:

```ts
import { CRAFT_GUIDE, ENDING_GUIDE } from '@/lib/generate-thread';
import { buildRepurposeSystem } from '../repurpose-thread';

describe('buildRepurposeSystem craft rules', () => {
  it('includes the craft guide and the natural ending rule', () => {
    const system = buildRepurposeSystem(8, 'auto');
    expect(system).toContain(CRAFT_GUIDE);
    expect(system).toContain(ENDING_GUIDE);
    expect(system).not.toContain('takeaway or CTA');
  });
});
```

(Merge imports if `buildRepurposeSystem` is already imported.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/services/__tests__/repurpose-thread.test.ts`
Expected: FAIL.

- [ ] **Step 3: Wire it**

In `frontend/src/lib/services/repurpose-thread.ts`: add `CRAFT_GUIDE, ENDING_GUIDE` to the import from `@/lib/generate-thread`. In `buildRepurposeSystem`, insert `CRAFT_GUIDE,` after the role line, and replace:

```ts
    'Tweet 1 must be a strong hook. The last tweet wraps up with a takeaway or CTA.',
```

with:

```ts
    'Tweet 1 must be a strong hook.',
    ENDING_GUIDE,
```

Insert `CRAFT_GUIDE,` after the role line in the `generatePreview` and `regenerateOne` inline system arrays too.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS. Also check an existing repurpose test doesn't assert the removed sentence — if one does, update it to expect `ENDING_GUIDE`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/repurpose-thread.ts src/lib/services/__tests__/repurpose-thread.test.ts
git commit -m "feat(repurpose): apply craft guide and natural ending rule"
```

---

### Task 9: Eval script — matrix runner with dry-run

A dev-only script comparing the **frozen old prompt** (inlined baseline, pre-overhaul wording) against the live new `buildThreadPrompt` across Groq models. tsx becomes a devDependency so the script can import the TS lib (Node 22.16 type-stripping can't resolve the lib's extensionless imports).

**Files:**
- Create: `frontend/scripts/eval-prompts.ts`
- Modify: `frontend/package.json` (devDependency `tsx`, script `eval:prompts`)

**Interfaces:**
- Consumes: `buildThreadPrompt`, `callLlm`, `parseThreadJson`, `resolveLlmConfig`, `assertApiKey` from `../src/lib/generate-thread`.
- Produces: CLI — `npm run eval:prompts -- [--dry-run] [--models=a,b] [--pairs=N]`; writes `frontend/eval-results.md`.

- [ ] **Step 1: Install tsx and add the npm script**

Run from `frontend/`: `npm install -D tsx`

In `package.json` scripts add (`--env-file` supplies `GROQ_API_KEY`; `--import tsx` enables TS imports):

```json
    "eval:prompts": "node --env-file=.env.local --import tsx scripts/eval-prompts.ts"
```

- [ ] **Step 2: Write the script**

Create `frontend/scripts/eval-prompts.ts`:

```ts
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
```

- [ ] **Step 3: Verify the dry run**

Run: `npm run eval:prompts -- --dry-run`
Expected: prints `matrix: 8 pairs x 4 models x 2 prompts = 64 runs` and 32 matrix lines. No network calls, exit 0.

- [ ] **Step 4: Run the full suite (imports must not break the app)**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/eval-prompts.ts package.json package-lock.json
git commit -m "chore(eval): prompt/model matrix runner (tsx, dry-run verified)"
```

---

### Task 10: Gitignore the results + smoke-run one live cell

**Files:**
- Modify: `frontend/.gitignore`

- [ ] **Step 1: Gitignore the report**

Add to `frontend/.gitignore` (near the `.env*` block):

```
# prompt eval output (human-graded, never committed)
eval-results.md
```

- [ ] **Step 2: Smoke-run one cell live**

Run: `npm run eval:prompts -- --pairs=1 --models=llama-3.3-70b-versatile`
Expected: `2/2` progress, `wrote eval-results.md`; the file contains an OLD and a NEW section with numbered tweets (or an ERROR block — investigate before committing). Confirm `git status` does NOT list `eval-results.md`.

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore(eval): gitignore eval-results.md"
```

---

### Task 11: Full verification + eval run (no commit)

- [ ] **Step 1: Full test suite and lint**

Run from `frontend/`: `npm test && npm run lint`
Expected: both PASS.

- [ ] **Step 2: Full eval run**

Run: `npm run eval:prompts`
Expected: 64/64 cells, `wrote eval-results.md` (~5–10 minutes with rate-limit delays). A few ERROR cells from one model are acceptable — note them; systematic failures of a model mean drop that model from consideration.

- [ ] **Step 3: Hand off for human grading**

Deliver `eval-results.md` to the user to grade side-by-side. Decision to capture: (a) keep or iterate the new prompt, (b) winning model → set `LLM_MODEL` in `.env.local` and Vercel env (no code change). Not part of this plan's commits.

---

## Self-review notes

- Spec coverage: CRAFT_GUIDE/HOOK_GUIDE/ENDING_GUIDE (§1) → Tasks 2–4; personas + exemplars (§1) → Tasks 5–6; eval script §2 → Tasks 9–10; model selection §3 → Task 11 handoff; testing §4 → every task + Task 11. Tasks 7–8 extend §1's craft rules to the two sibling services that share `TONE_GUIDE` — a small, deliberate scope addition so service quality doesn't diverge.
- Type consistency: builder signatures fixed in Task 1 and reused verbatim in Tasks 2, 4, 6; `CRAFT_GUIDE`/`ENDING_GUIDE` names match across Tasks 2/3/7/8.
- The testnet E2E smoke from the spec's §4 is covered more directly by Task 10's live cell (it exercises the exact `callLlm` path the app uses); a full x402 testnet flow adds nothing for a prompt-string change.
