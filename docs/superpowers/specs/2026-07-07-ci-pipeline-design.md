# CI Pipeline — Design

**Date:** 2026-07-07
**Status:** Approved, ready for planning

## Goal

Add a GitHub Actions CI pipeline that gates every push/PR on the checks that are
currently green — frontend `test` + `build`, and contracts `test` + `clarinet check`.
This is the safety net a solo, commit-on-`main` workflow otherwise lacks: nothing today
stops a broken commit from reaching `main`.

## Scope decisions (from brainstorming)

- **What gates (fails CI):** frontend `npm test` + `npm run build`; contracts `npm test`
  + `clarinet check`. All four block.
- **Deferred:** `lint` and `tsc --noEmit` are NOT in this pipeline. Both currently exit
  non-zero on `main` (2 real ESLint errors — `AppSplash` Date.now-in-render,
  `ThemeContext` setState-in-effect — plus a type error in `regenerate/route.test.ts`).
  Gating on them now would make CI red from day one. They belong to the separate
  "fix lint/type smells" work (rec #3), after which they can be added as gates.
- **Workspaces:** both `frontend/` and `contracts/`.
- **Triggers:** `push` (all branches) + `pull_request` + `workflow_dispatch`.
- **Structure:** a single workflow file with two parallel jobs (not two files with path
  filters — YAGNI for a repo this size; can split later).

## Key constraints discovered

- **`next build` needs environment.** `NEXT_PUBLIC_*` are inlined at build time and
  `assertServerEnv` (`lib/env.ts`, run at boot via `instrumentation.ts`) validates a
  required set. Without `.env.local`, CI must supply a dummy, non-secret, testnet-shaped
  env or the build fails. The server never runs in CI, so these values are placeholders.
- **Contracts `npm test` does NOT need the clarinet binary** — `vitest-environment-clarinet`
  / `@stacks/clarinet-sdk` bundle the simnet. Only `clarinet check` needs the CLI.
- **Both workspaces have `package-lock.json`** → `npm ci` works in each.
- **Webpack only** — `npm run build` already carries `--webpack`; do not alter.

## Architecture

One workflow: `.github/workflows/ci.yml`, `name: CI`.

```yaml
on:
  push:
  pull_request:
  workflow_dispatch:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

`cancel-in-progress` supersedes an in-flight run for the same ref when a newer push
arrives (avoids pile-ups on rapid pushes to `main`).

### Job `frontend` (ubuntu-latest)

- Node 22 via `actions/setup-node@v4`, `cache: npm`,
  `cache-dependency-path: frontend/package-lock.json`.
- Job-level `env` — dummy, non-secret, testnet-shaped (committed in the file):
  - `NEXT_PUBLIC_STACKS_NETWORK: testnet`
  - `NEXT_PUBLIC_CONTRACT: ST000000000000000000002AMW42H.thread-pay` (ST = testnet)
  - `NEXT_PUBLIC_APP_DOMAIN: example.com`
  - `SUPABASE_URL: https://example.supabase.co`
  - `SUPABASE_SERVICE_ROLE_KEY: ci-dummy-service-role-key`
  - `AUTH_SESSION_SECRET: ci-dummy-session-secret-0000000000000000` (≥32 chars)
  - `LLM_PROVIDER: ollama` (makes `assertServerEnv` skip the API-key requirement)
- Steps (all `working-directory: frontend`): `actions/checkout@v4` → setup-node →
  `npm ci` → `npm test` → `npm run build`.

Rationale for the env values: `assertServerEnv` requires `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_CONTRACT`, `AUTH_SESSION_SECRET` (≥32), and an
LLM key unless the provider is `ollama`. On a testnet build it only *rejects* a
mismatched `NEXT_PUBLIC_HIRO_API`/`NEXT_PUBLIC_SBTC_CONTRACT` when set — leaving them
unset is valid. `NEXT_PUBLIC_APP_DOMAIN` covers `postToX`/config reads at build import.

### Job `contracts` (ubuntu-latest)

- Node 22 via `actions/setup-node@v4`, `cache: npm`,
  `cache-dependency-path: contracts/package-lock.json`.
- Steps: `actions/checkout@v4` → setup-node → `npm ci` (in `contracts`) →
  `npm test` (in `contracts`) → install clarinet CLI **pinned to `v3.14.1`** (download
  `clarinet-linux-x64-glibc.tar.gz` from the GitHub release, extract, place on `PATH`)
  → `clarinet check` (in `contracts`).

No job-level env needed — the simnet is self-contained.

## Testing

There is no unit test for a YAML workflow; the evidence is that each gated command
passes when run exactly as CI runs it:

- `frontend`: `npm test` (271 pass) and `npm run build` (webpack) — already confirmed green.
- `contracts`: `npm test` and `clarinet check` — run locally (clarinet 3.14.1 is
  installed) to confirm green before merge.
- Validate the workflow YAML parses (e.g. a YAML lint / `actionlint` if available, else a
  parser check).

## Out of scope (explicitly deferred)

- `lint` / `tsc` gates → after rec #3 cleanup.
- Path-filtered per-workspace workflows.
- Caching beyond npm (e.g. Next build cache).
- Deploy / release automation.
- Migration-application safety (rec #2, its own spec).
