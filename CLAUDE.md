# ThreadGogh

High-level index for this repo. Deep detail lives in `.claude/docs/` — follow the
links in **Additional Documentation** before touching a domain you don't know.

## 1. Project Overview

ThreadGogh generates X (Twitter) threads with an LLM and charges per generation via
an x402-style flow on Stacks: the API returns HTTP 402 with an invoice, the user pays
STX or sBTC on-chain to a Clarity contract that records a receipt, and the server
verifies that receipt before generating. No accounts, no subscriptions — payment is
the only gate.

## 2. Tech Stack

- **Next.js 16.2.9** (App Router) + **React 19.2.4** — frontend + API routes (`frontend/`)
- **TypeScript 5**, **Ant Design 6.4.4**, **Tailwind 4**, React Compiler
- **@stacks/connect 8.2.6**, **@stacks/transactions 7.4.0** — wallet + on-chain calls
- **@supabase/supabase-js 2.108.1** — Postgres (invoices, generations)
- **Clarinet / Clarity v4** — smart contracts (`contracts/`)
- **Vitest 4.1.8** — unit + route tests
- LLM: provider-agnostic (Groq default). NOT the Anthropic/Claude API. See docs.

## 3. Dev Commands

Frontend (run from `frontend/`):

```bash
npm install
npm run dev      # next dev --webpack   (MUST be webpack — see Key Constraints)
npm run build    # next build --webpack
npm test         # vitest run
npm run lint
```

Requires `frontend/.env.local` (see `frontend/.env.example`). Migrations to apply in
Supabase live in `frontend/supabase/migrations/`.

Contracts (run from `contracts/`):

```bash
clarinet check                                   # type-check Clarity
npm test                                          # simnet unit tests (vitest)
clarinet deployments apply --testnet --no-dashboard -d   # deploy (needs Testnet.toml)
```

## 4. Core Logic Summary

Pay-per-generate, payment-gated by an on-chain receipt:

1. `POST /api/generate` with `{topic,tone,length}` → creates an invoice (random
   32-byte id), returns **HTTP 402** + price + contract id.
2. Client signs `pay-stx`/`pay-sbtc` on `thread-pay`; the contract stores a receipt
   keyed by invoice id. Price is a **minimum** (`amount >= min-price`).
3. `POST /api/generate` with `{invoiceId, txId}` → server reads the receipt on-chain,
   checks `amount >= quoted price`, then generates and persists the thread.

An atomic DB lock (`pending → generating → consumed`) makes generation idempotent and
double-spend-safe. Full lifecycle in `.claude/docs/data-model.md`.

## 5. Key Constraints

Things to never change or assume without explicit reason:

- **Webpack only.** `dev`/`build` use `--webpack`. Turbopack breaks `@stacks/transactions`
  (WASM/bundling). Do not remove the flag.
- **This Next.js is modified.** Before writing frontend code, read the relevant guide
  in `frontend/node_modules/next/dist/docs/` (per `frontend/AGENTS.md`). APIs may
  differ from your training data.
- **Wallet calls MUST carry post-conditions.** The wallet runs deny-mode; any token a
  contract-call moves must be declared or it rolls back. See `.claude/docs/payments.md`.
- **LLM is pluggable, not Claude.** Switch via `LLM_PROVIDER`; default Groq (free).
  Don't hardwire a provider or add `@anthropic-ai/sdk`.
- **The on-chain receipt is the source of truth for payment** — never mark an invoice
  paid/consumed from client input alone.
- **`SUPABASE_SERVICE_ROLE_KEY` is server-only.** Never import `lib/supabase.ts` into a
  client component or expose it via `NEXT_PUBLIC_*`.
- **This app is LIVE ON MAINNET with real money.** `SP2CMK69QNY60HBG8BJ4X5TD7XX2ZT4XB62V13SV.thread-pay`,
  0.1 STX per generation, real users have paid. Treat any change to the payment path as a
  production change. Network comes from `NEXT_PUBLIC_STACKS_NETWORK` (code default
  `testnet`, but `.env.local` is `mainnet`), resolved once in `lib/config.ts`; a matching
  `NEXT_PUBLIC_CONTRACT` and `NEXT_PUBLIC_HIRO_API` must be set with it. Use testnet for
  free E2E testing.
- **The deployed contract cannot enforce a specific invoice's price.** `min-price-stx` is
  one global minimum (0.1 STX) while quotes vary per service and ×3 for multi-tone. An
  underpaid-but-accepted payment strands the user's funds with no refund path. Fixing it
  needs a redeploy — until then, **adding a service at a new price widens the exposure**.
  See "Known limits" in `.claude/docs/contracts.md` and the
  `frontend/scripts/audit-stranded.mjs` detector.
- **Server env is validated at boot** (`instrumentation.ts` → `lib/env.ts`) and defensively
  in the generate route. A missing var fails fast with a clear message — keep it that way.
- **Never commit secrets.** `.env*.local` and `contracts/settings/Testnet.toml` are
  gitignored; keep it that way.

## 6. Additional Documentation

- [`.claude/docs/architecture.md`](.claude/docs/architecture.md) — repo layout, request
  lifecycle, the full x402 flow and error-status map.
- [`.claude/docs/contracts.md`](.claude/docs/contracts.md) — Clarity contracts,
  functions, error codes, receipt model, live mainnet address + known limits.
- [`.claude/docs/payments.md`](.claude/docs/payments.md) — wallet connect, post-conditions
  with `Pc`, `waitForTx` states, slow-confirmation recovery.
- [`.claude/docs/data-model.md`](.claude/docs/data-model.md) — Supabase schema, invoice
  state machine, atomic locks, stale-lock recovery, migrations.
- [`.claude/docs/llm-providers.md`](.claude/docs/llm-providers.md) — provider abstraction,
  env config, output contract and parsing.
- [`.claude/docs/mainnet-deploy.md`](.claude/docs/mainnet-deploy.md) — ordered mainnet
  runbook: deploy without mock-sbtc, set-sbtc-contract, RLS, env switch, smoke test.
