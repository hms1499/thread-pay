# CI Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub Actions CI pipeline that gates every push/PR on the currently-green checks — frontend `test` + `build`, and contracts `test` + `clarinet check`.

**Architecture:** One workflow file `.github/workflows/ci.yml` with two parallel jobs (`frontend`, `contracts`). Task 1 lays down the triggers/concurrency and the `frontend` job; Task 2 appends the `contracts` job to the same file. No lint/tsc gates (both currently red — deferred).

**Tech Stack:** GitHub Actions, `actions/checkout@v4`, `actions/setup-node@v4`, Node 22, npm, Clarinet CLI v3.14.1.

## Global Constraints

- **Deferred, do NOT add:** `lint` and `tsc --noEmit` gates — both exit non-zero on `main` today; adding them would make CI red from day one.
- **Webpack only** — `npm run build` already carries `--webpack`; never alter it.
- **Node 22** for both jobs.
- **Clarinet pinned to `v3.14.1`** (matches local); install by downloading `clarinet-linux-x64-glibc.tar.gz` from the GitHub release.
- **Frontend `env` values are dummy, non-secret, testnet-shaped** — the server never runs in CI. Exact values are in Task 1; use them verbatim.
- **Both workspaces use `npm ci`** (each has its own `package-lock.json`).
- **No secrets in the workflow file** — only the documented dummy placeholders.

---

### Task 1: Workflow skeleton + `frontend` job

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: a `CI` workflow triggered on `push` / `pull_request` / `workflow_dispatch`, with a `frontend` job. Task 2 appends a sibling `contracts` job under the same `jobs:` key.

- [ ] **Step 1: Create the workflow file with the frontend job**

Create `.github/workflows/ci.yml` with exactly this content:

```yaml
name: CI

on:
  push:
  pull_request:
  workflow_dispatch:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  frontend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: frontend
    env:
      NEXT_PUBLIC_STACKS_NETWORK: testnet
      NEXT_PUBLIC_CONTRACT: ST000000000000000000002AMW42H.thread-pay
      NEXT_PUBLIC_APP_DOMAIN: example.com
      SUPABASE_URL: https://example.supabase.co
      SUPABASE_SERVICE_ROLE_KEY: ci-dummy-service-role-key
      AUTH_SESSION_SECRET: ci-dummy-session-secret-0000000000000000
      LLM_PROVIDER: ollama
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: npm ci
      - run: npm test
      - run: npm run build
```

- [ ] **Step 2: Validate the YAML parses**

Run (from repo root): `ruby -ryaml -e "YAML.load_file('.github/workflows/ci.yml'); puts 'YAML OK'"`
Expected: prints `YAML OK`. (Ruby's YAML 1.1 parser maps the `on:` key to boolean `true` — that's expected and harmless; we only care that it parses without error.)

- [ ] **Step 3: Prove the dummy env is sufficient (simulate CI locally)**

The point of this step is to confirm the `env:` block is complete enough for `next build` WITHOUT `.env.local`. Temporarily move `.env.local` aside, run the two gated commands with only the dummy env, then always restore it.

Run (from repo root):

```bash
cd frontend
test -f .env.local && mv .env.local .env.local.cibak || true
trap 'test -f .env.local.cibak && mv .env.local.cibak .env.local || true' EXIT
export NEXT_PUBLIC_STACKS_NETWORK=testnet
export NEXT_PUBLIC_CONTRACT=ST000000000000000000002AMW42H.thread-pay
export NEXT_PUBLIC_APP_DOMAIN=example.com
export SUPABASE_URL=https://example.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=ci-dummy-service-role-key
export AUTH_SESSION_SECRET=ci-dummy-session-secret-0000000000000000
export LLM_PROVIDER=ollama
npm test && npm run build
```

Expected: `npm test` passes (271 tests) and `npm run build` completes ("Compiled successfully" / route table printed) using only the dummy env (no `.env.local` present). `.env.local` is restored on exit via the trap. Run this in a subshell/one Bash invocation so the `trap ... EXIT` fires and restores `.env.local`.
If `next build` instead throws `Invalid server environment: ...`, the `env:` block is missing a key — add the named key to both the workflow `env:` and this command, then re-run.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow with frontend test + build job"
```

---

### Task 2: `contracts` job

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the `jobs:` map created in Task 1.
- Produces: a `contracts` job running `npm ci` → `npm test` → install Clarinet v3.14.1 → `clarinet check`.

- [ ] **Step 1: Append the contracts job**

Add this job under `jobs:` in `.github/workflows/ci.yml`, as a sibling of `frontend` (same indentation as `frontend:`), after the `frontend` job:

```yaml
  contracts:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: contracts
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: contracts/package-lock.json
      - run: npm ci
      - run: npm test
      - name: Install Clarinet
        run: |
          curl -sSL https://github.com/hirosystems/clarinet/releases/download/v3.14.1/clarinet-linux-x64-glibc.tar.gz -o /tmp/clarinet.tar.gz
          tar -xzf /tmp/clarinet.tar.gz -C /tmp
          sudo mv /tmp/clarinet /usr/local/bin/clarinet
          clarinet --version
      - run: clarinet check
```

- [ ] **Step 2: Validate the YAML parses and both jobs exist**

Run (from repo root):

```bash
ruby -ryaml -e "d=YAML.load_file('.github/workflows/ci.yml'); j=d['jobs'].keys.sort; puts j.inspect; raise 'missing jobs' unless j == ['contracts','frontend']"
```
Expected: prints `["contracts", "frontend"]` and does not raise.

- [ ] **Step 3: Confirm the pinned Clarinet asset URL exists**

The Linux install step can't be exercised on macOS, but the pinned release asset can be confirmed to exist (HEAD request, follows redirects):

Run: `curl -sIL -o /dev/null -w "%{http_code}\n" https://github.com/hirosystems/clarinet/releases/download/v3.14.1/clarinet-linux-x64-glibc.tar.gz`
Expected: `200` (the redirect chain to the release CDN resolves to 200). If it prints `404`, the asset name/version is wrong — stop and re-check the release page before committing.

- [ ] **Step 4: Verify the contracts gates pass locally**

Run the two commands the `contracts` job gates on, using the locally-installed Clarinet 3.14.1:

```bash
cd contracts && npm test && clarinet check
```
Expected: `npm test` passes (simnet suite green) and `clarinet check` reports the contracts type-check as OK (no errors).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add contracts test + clarinet check job"
```

---

### Task 3: Final verification gate

**Files:** none (verification only)

- [ ] **Step 1: Re-validate the complete workflow YAML**

Run (from repo root): `ruby -ryaml -e "YAML.load_file('.github/workflows/ci.yml'); puts 'YAML OK'"`
Expected: `YAML OK`.

- [ ] **Step 2: Confirm clean tree and the two commits**

Run: `git status --short && git log --oneline -2`
Expected: clean tree; the two `ci:` commits present.

- [ ] **Step 3: Operator note (manual, not automated here)**

The first real end-to-end proof is a live Actions run. When the user chooses to push, the workflow runs on GitHub; watch that both jobs (`frontend`, `contracts`) go green. This requires a GitHub remote and a push — per repo convention, do not push without the user's explicit request. Record this as the remaining manual verification.
