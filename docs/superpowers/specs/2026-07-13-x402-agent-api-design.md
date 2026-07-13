# x402 Agent-Payable API — Design

**Date:** 2026-07-13
**Status: 🛑 SHELVED — do not implement. Kept as completed research.**

## Why this was shelved (read this before reviving it)

The design was approved, then killed by its own premise check. The pitch was "the
cheapest way to find out whether agents will buy a thread." Reading the actual market
answered that for free, before any code was written:

The public x402 directory (`stx402.com/registry/list`, read 2026-07-13):

| | |
|---|---|
| Endpoints registered | 202 — but **70 are category `test`** |
| Distinct owners | **10** |
| AI endpoints | **4** (3 of them owned by one person) |
| Last registration of any kind | **2026-04-16** — three months of silence |

Worse for the distribution story: the agent tooling that actually discovers endpoints
(aibtc's `list_x402_endpoints`) reads from **four curated sources, not this registry**.
Registering would not reliably surface ThreadGogh to the agents that do exist.

The agent market on Stacks is pre-revenue. Building the endpoint would be opening a shop
on a street we counted as empty. Effort went to prepaid credits instead — that attacks a
**measured** 48% payment-step drop-off from real users.

**Revive this if** the x402 registry starts growing again, or an agent counterparty asks
for the endpoint directly.

## ⚠️ Known bug in the design below

The spec says the payment proof arrives in an **`X-PAYMENT`** header. **That is wrong.**
Both `stx402.com` and `x402.aibtc.com` advertise the canonical v2 headers as:

```
request:  payment-signature
response: payment-response
required: payment-required
```

Using `X-PAYMENT` would mean no agent could ever pay. Fix this before implementing.
Everything below is otherwise as-approved.

---

## Problem

ThreadGogh has 13 paid generations and a 48% drop-off at the payment step (12 of 25
quotes were abandoned before paying). The bottleneck is demand, not features.

`POST /api/generate` already speaks a 402-based payment flow, so there is an untapped
class of customer that costs almost nothing to reach: **autonomous agents**. They pay
from a wallet, need no UI, and no signup. The point of this project is to answer one
question cheaply: **will anything — human or machine — buy a thread at 0.1 STX?**

## Key finding: real x402 does not use a contract

The live x402 ecosystem on Stacks (31 endpoints across `x402.biwas.xyz`,
`x402.aibtc.com`, `stx402.com`, `aibtc.com`) uses a protocol that is **not** what
ThreadGogh implements:

| | ThreadGogh today | x402 v2 standard |
|---|---|---|
| Payment target | `thread-pay` **contract** | plain **EOA** address (`payTo`) |
| Payment proof | on-chain **receipt map** | **signed transaction** in `X-PAYMENT` header |
| Shape | invoice → tx → wait for block → 2nd POST with `txId` | **one request**, synchronous |
| Client compat | none — bespoke | every existing agent client |

So the agent path **bypasses `thread-pay` entirely**. Payment is a direct STX transfer
to the treasury wallet. This was accepted deliberately: compatibility with the existing
agent ecosystem was chosen over preserving the contract-based trust model, because an
incompatible endpoint gets zero agent traffic no matter how trust-minimized it is.

The canonical 402 response (verified against `x402.aibtc.com`):

```
HTTP/2 402
payment-required: <base64 of the body below>
access-control-allow-origin: *
access-control-expose-headers: payment-required,payment-response,X-PAYMENT-RESPONSE,X-PAYER-ADDRESS
```
```json
{ "x402Version": 2,
  "resource": { "url": "/api/x402/x-thread",
                "description": "Generate an X (Twitter) thread from a topic",
                "mimeType": "application/json" },
  "accepts": [{ "scheme": "exact", "network": "stacks:1", "amount": "100000",
                "asset": "STX", "payTo": "SP2CMK69QNY60HBG8BJ4X5TD7XX2ZT4XB62V13SV",
                "maxTimeoutSeconds": 300 }] }
```

`facilitatorUrl` is **not** sent to the client in v2. Whether the server outsources
verification to a facilitator or does it itself is invisible to the agent — so
self-verifying costs no compatibility.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Protocol | x402 v2, ecosystem-compatible | An endpoint no client can call is worth nothing |
| Price | **0.1 STX**, same as web | The endpoint is public; a cheaper agent price would cannibalise the web price. If nobody buys at 0.1, that is itself the answer, and cutting price later is easier than raising it |
| Scope | **`x-thread` only.** No multi-tone, no regenerate, no sBTC | Smallest surface that answers the demand question |
| Verification | **Self-verify** — no facilitator, no `x402-stacks` dep | See below |
| Delivery | **Optimistic** — broadcast, do not wait for confirmation | Stays inside the serverless time budget; worst case costs one free Groq call |

### Why not the `x402-stacks` npm package

Its "verifier" is only an HTTP client for a hosted facilitator — it contains no local
verification (no `deserializeTransaction`, no `broadcastTransaction`). It contributes
nothing to self-verification, **and it depends on `@stacks/transactions@^6` while this
repo is on `7.4.0`**. Two majors of the exact package that forces the webpack-only
constraint (WASM/bundling) is a risk with no upside. **Do not install it.**

Self-verification needs no new dependency: the payment payload is a signed Stacks
transaction, and `@stacks/transactions@7` (already present) can deserialize it.

## Architecture

```
POST /api/x402/x-thread
```

**No `X-PAYMENT` header** → `402` + requirements. Creates **no invoice** and makes **no
LLM call**. (The human quote branch burns an LLM call for `previewHook` on every unpaid
quote — for agents that is both useless and a free way to run up the LLM bill.)

**With `X-PAYMENT`** → verify → broadcast → generate → `200` + thread +
`X-PAYMENT-RESPONSE`.

### Modules

| Module | Responsibility | Depends on |
|---|---|---|
| `lib/x402/requirements.ts` | Build + base64-encode the 402 payload | nothing — pure |
| `lib/x402/verify.ts` | Decode `X-PAYMENT`, deserialize the signed tx, validate | `@stacks/transactions` |
| `lib/x402/settle.ts` | Broadcast via Hiro; tolerate "already broadcast" | `fetch` |

`verify.ts` rejects unless **all** hold:

1. payload is an **STX token-transfer** (never a contract-call — do not infer intent
   from an arbitrary transaction)
2. `recipient == payTo` (the treasury wallet)
3. `amount >= 100000` microSTX (overpayment allowed, consistent with the contract)
4. network matches (mainnet)
5. signature valid → sender address recoverable = the payer

It makes **no network calls**, so it is fully unit-testable from fixtures.

### Storage: the txid *is* the invoice id

A Stacks txid is **32 bytes** — exactly the existing `invoice_id` width — and it is
computable **before** broadcast from the signed transaction.

```
verify(X-PAYMENT)              → { payer, amount, txid, txHex }
validate params                → 400 before any money moves
INSERT invoice { invoice_id: txid, rail: 'x402', status: 'pending' }
                               → duplicate key = REPLAY, rejected by the DB itself
broadcast(txHex)
claimInvoice(txid)             → existing atomic pending→generating lock
generate(params)
saveGenerationAndConsume(...)  → payer_address, amount, tx_id
```

This reuses the whole existing invoice machinery, and **replay protection is free** — it
is the primary key's unique constraint. No new table, no bespoke nonce logic.

**Order is deliberate.** Params are validated *before* broadcast so an agent is never
charged for a bad `topic`. The invoice is INSERTed *before* broadcast so the DB — which
is atomic — is the first gate; broadcasting first would let a duplicate request broadcast
twice before the replay guard could fire.

Two things this requires of the existing code — both easy to get wrong:

- **`createInvoice` must accept an explicit invoice id.** Today it hardcodes
  `invoice_id: crypto.randomBytes(32)` (`lib/invoices.ts:45`). Add an optional
  `invoiceId` argument; keep the random default for the web path.
- **A duplicate-key error is a REPLAY, not a failure.** `createInvoice` currently throws
  on any insert error. The agent path must distinguish Postgres unique-violation
  (`23505`) from a real DB error and route it to the replay branch (return the stored
  thread), not to a 500.

**The agent path never checks expiry.** `createInvoice` stamps a 15-minute `expires_at`,
and the web flow uses it — but an x402 invoice is *already paid* the moment it exists. If
generation fails and the agent retries 20 minutes later, an expiry check would take its
money and refuse the work. Expiry must not be consulted on this path at all.

### Migration `0013`

`invoices` gains `rail text not null default 'contract'` (`'contract' | 'x402'`).

This is not cosmetic. **`audit-stranded.mjs` is blind to the agent path**: it looks for
an on-chain *receipt*, and x402 payments never write one. An agent could pay, have
generation fail, and be silently stranded. The `rail` column plus the stored txid make a
second reconciler possible: *invoices where `rail='x402'` and status != `consumed` and a
txid exists → look the tx up on chain → if it succeeded, that agent is owed a refund.*

## Error handling

| Case | Response | Rationale |
|---|---|---|
| Missing / malformed `X-PAYMENT` | `402` + requirements | A conforming client signs and retries |
| Verify fails (wrong recipient, underpaid, wrong network, bad signature) | `402` + explicit `error` | The agent must learn *what* it signed wrong |
| Invalid params | `400` | Checked before broadcast — never take money then reject the input |
| Replay of a `consumed` invoice | `200` + the stored thread | Idempotent, same as the web flow |
| Replay while generating | `202` | Existing atomic lock |
| Broadcast rejected (bad nonce, insufficient funds) | `402`, delete the invoice | No money, no reservation |
| LLM fails **after** broadcast | `500`, release the lock, **keep the invoice** | The agent retries with the same `X-PAYMENT`, lands on the paid invoice, and regenerates **free**. Funds preserved |

The last row is the payoff of using the txid as the invoice id: a retry naturally
resolves to the invoice that was already paid.

## Security

- **CORS `*`** plus `access-control-expose-headers` and an `OPTIONS` handler — browser
  agents must read `payment-required`. The endpoint is public anyway; this adds no risk.
- **Rate-limit the 402 branch** per IP via the existing `checkRateLimit`. It is cheap now
  (no LLM) but still writes to the DB.
- **Price is never read from the client** — it comes from the server-side registry. This
  is the exact class of mistake that produced the contract's price-enforcement gap.
- **Only plain token-transfers are accepted.**

## Testing

`verify.ts` touches no network, so it is tested directly against **fixture signed
transactions** (a fixed test key, hex committed — no wallet, no chain).

| Test | Expect |
|---|---|
| valid tx, right recipient, right amount | `{ payer, amount, txid }` |
| recipient is a **different wallet** | reject — the single most important test |
| 99999 microSTX (1 short) | reject |
| overpayment | accept |
| a **testnet** tx sent to mainnet | reject |
| payload is a **contract-call** | reject |
| garbage base64 / corrupt tx | reject cleanly, never a 500 |
| txid computed pre-broadcast == txid after broadcast | pins the assumption the whole design rests on |

That last one is load-bearing: **replay protection collapses if the pre-computed txid is
not the real one.**

Route tests follow the existing vitest patterns: no header → correct 402 shape; replay →
returns the stored thread; LLM failure → 500 with the invoice preserved.

**E2E on testnet first** (free), before mainnet is enabled.

## Discovery — where the value actually is

Code nobody can find is worth zero.

1. **`GET /api/x402/manifest`** — generated from the `SERVICES` registry (`fields` already
   carries type/maxLen/options), so it cannot drift from the services.
2. **Register in the public registries** (`stx402.com/registry`, `x402.aibtc.com`). This
   is where agents actually look. **This is an outward-facing publish action and requires
   the user's explicit go-ahead before it is performed.**
3. **README + a copy-pasteable client snippet.**

Step 2 *is* the project. Steps 1 and 3 are prerequisites.

## Definition of done

- `npm test` green, including the `verify.ts` suite
- Testnet E2E: agent pays → receives a thread → tx lands on chain
- Endpoint listed in at least one public registry
- The x402 reconciler reports **0** stranded agents

## Out of scope

sBTC on the agent path; multi-tone; regenerate; waiting for confirmation; any change to
`thread-pay` (that is the separate v2-redeploy track).
