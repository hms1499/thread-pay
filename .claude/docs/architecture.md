# Architecture

## Repo layout

```
threadpay/
├── contracts/              # Clarinet project (Clarity v4)
│   ├── contracts/
│   │   ├── traits.clar         # minimal ft-trait (transfer)
│   │   ├── mock-sbtc.clar      # SIP-010 mock for simnet tests
│   │   └── thread-pay.clar     # main payment + receipt contract
│   ├── tests/thread-pay.test.ts
│   └── deployments/            # generated plans (simnet, testnet, mainnet)
└── frontend/               # Next.js 16 app
    └── src/
        ├── lib/
        │   ├── config.ts           # env, prices, contract ids, constants
        │   ├── supabase.ts         # service-role client (SERVER ONLY)
        │   ├── invoices.ts         # invoice CRUD + atomic generation lock
        │   ├── receipt.ts          # fetch + parse on-chain receipt
        │   ├── generate-thread.ts  # pluggable LLM call + output parsing
        │   └── stacks.ts           # CLIENT: connect, pay, waitForTx
        ├── app/
        │   ├── page.tsx            # client UI, drives the whole flow
        │   └── api/
        │       ├── generate/route.ts            # x402 quote + verify + generate
        │       ├── generation/[invoiceId]/route.ts  # re-fetch a bought thread
        │       ├── history/route.ts             # threads by wallet
        │       └── stats/route.ts               # totals for footer
        └── components/             # ThreadForm, TweetCard, PaymentStatus, HistoryPanel
```

## The x402 flow (end to end)

```
Client                    /api/generate                 Stacks (thread-pay)      Supabase
  │  POST {topic,tone,length}    │                              │                    │
  │ ───────────────────────────▶│ createInvoice ───────────────────────────────────▶│
  │  402 {invoiceId,price,...}   │                              │                    │
  │ ◀───────────────────────────│                              │                    │
  │  pay-stx / pay-sbtc (wallet) │                              │                    │
  │ ─────────────────────────────────────────────────────────▶│  receipt stored    │
  │  POST {invoiceId,txId}       │                              │                    │
  │ ───────────────────────────▶│ getInvoice ──────────────────────────────────────▶│
  │                             │ fetchReceipt (read-only) ───▶│                    │
  │                             │ claimInvoice (pending→generating) ────────────────▶│
  │                             │ generateThread (LLM)         │                    │
  │                             │ saveGenerationAndConsume ────────────────────────▶│
  │  200 {thread}               │                              │                    │
  │ ◀───────────────────────────│                              │                    │
```

`POST /api/generate` is the single entry point with two branches, keyed on whether the
body has an `invoiceId`:

- **No `invoiceId`** → quote branch: validate `topic`/`tone`/`length`, create invoice,
  return **402**.
- **Has `invoiceId`** → redeem branch: load invoice, short-circuit on
  `consumed`/`generating`, verify the on-chain receipt, claim the lock, generate, save.

## Response status map (redeem branch)

| Status | Meaning | Client action |
|--------|---------|---------------|
| 200 | thread returned (fresh or cached) | render it |
| 202 | a fresh `generating` lock is in progress | retry shortly ("Check payment") |
| 402 | no/under-paid receipt on-chain yet | wait, then retry |
| 404 | invoice id unknown | start over |
| 410 | expired AND never paid | request a new quote |
| 500 | LLM failed after claim — lock released, **payment preserved** | free retry |

Payment is verified **before** the expiry check: a late-confirmed payment on an expired
invoice is still honored, so funds are never lost. See `data-model.md` for the lock.
