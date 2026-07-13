# Clarity Contracts

Project: `contracts/` (Clarinet, Clarity v4). Three contracts.

## Deployed

**The app runs on mainnet.** The contract is live and has served paid generations.

| Network | `thread-pay` contract id | Status |
|---------|--------------------------|--------|
| **mainnet** | **`SP2CMK69QNY60HBG8BJ4X5TD7XX2ZT4XB62V13SV.thread-pay`** | **live — real STX** |
| testnet | `ST2CMK69QNY60HBG8BJ4X5TD7XX2ZT4XB4PBYSC2.thread-pay` | kept for free E2E testing |

Same deployer wallet on both networks (only the `SP`/`ST` prefix differs). The frontend
reads the contract id from `NEXT_PUBLIC_CONTRACT` — it is not hardcoded anywhere.

Live mainnet state (read from chain, not from env):

| Data var | Value |
|----------|-------|
| `owner` | `SP2CMK69QNY60HBG8BJ4X5TD7XX2ZT4XB62V13SV` |
| `treasury` | `SP2CMK69QNY60HBG8BJ4X5TD7XX2ZT4XB62V13SV` (same wallet as `owner`) |
| `min-price-stx` | `u100000` (0.1 STX) |
| `min-price-sbtc` | `u100` (100 sats) |
| `sbtc-contract` | `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` (mainnet sBTC ✅) |

Read any of these back with:

```bash
curl -s https://api.hiro.so/v2/data_var/SP2CMK69QNY60HBG8BJ4X5TD7XX2ZT4XB62V13SV/thread-pay/min-price-stx
```

### Known limits of the live contract

Two gaps that cannot be fixed without a redeploy — know them before adding pricing:

- **`min-price-*` is a single global minimum, so the contract cannot enforce the price of
  a specific invoice.** The server quotes per service and multiplies by 3 for multi-tone
  (0.3 STX), but the contract still only asserts `amount >= 0.1 STX`. A client that
  underpays a 0.3 STX quote gets its payment **accepted on-chain** (funds move to
  treasury, invoice id burned by `ERR-DUPLICATE-INVOICE`) while the server returns 402
  forever — funds lost, no on-chain refund path. Today only an honest client prevents
  this; no attacker profits from it, but any client bug strands a real user.
  **Widen this gap every time you add a service at a new price.**
- **`owner` cannot be rotated** — there is no `transfer-ownership`. Losing the owner key
  permanently freezes `set-prices` / `set-treasury` / `set-sbtc-contract`. `owner` is also
  `treasury`, so that one key holds the revenue too. `set-treasury` to a separate wallet
  needs no redeploy and reduces the blast radius today.

`frontend/scripts/audit-stranded.mjs` is the read-only detector for the first gap: it
lists invoices with an on-chain receipt that never reached `consumed`. Last run: **0
stranded** out of 25 invoices. Refunds, if ever needed, go out by hand from the treasury
wallet (it is an EOA, not the contract — the contract never holds funds).

## `thread-pay.clar`

Records a payment receipt per invoice. The receipt map is the source of truth the
backend trusts; the DB only mirrors it.

```clarity
(define-map receipts (buff 32)
  { payer: principal, amount: uint, token: (string-ascii 4), paid-at: uint })
```

### Public functions

| Function | Args | Notes |
|----------|------|-------|
| `pay-stx` | `(invoice-id (buff 32)) (amount uint)` | transfers STX `tx-sender → treasury`, writes receipt `token="STX"` |
| `pay-sbtc` | `(token <ft-trait>) (invoice-id (buff 32)) (amount uint)` | `token` must equal `sbtc-contract`; writes `token="SBTC"` |
| `set-prices` | `(stx uint) (sbtc uint)` | owner only |
| `set-sbtc-contract` | `(principal)` | owner only |
| `set-treasury` | `(principal)` | owner only |

### Read-only

- `get-receipt (invoice-id (buff 32))` → `(optional {payer,amount,token,paid-at})`
- `get-prices` → `{ stx: uint, sbtc: uint }`

### Error codes

| Code | Constant | Cause |
|------|----------|-------|
| `u100` | `ERR-UNDERPAID` | `amount < min-price` |
| `u101` | `ERR-DUPLICATE-INVOICE` | invoice id already has a receipt |
| `u102` | `ERR-NOT-OWNER` | admin fn called by non-owner |
| `u103` | `ERR-WRONG-TOKEN` | `pay-sbtc` token ≠ `sbtc-contract` |

### Invariants

- **Price is a minimum.** `amount >= min-price`; overpayment is allowed and recorded.
- **Invoice id is single-use on-chain.** A second `pay-*` with the same id fails with
  `u101` — this is the on-chain anti-replay guard.
- Defaults: `min-price-stx = u100000` (0.1 STX), `min-price-sbtc = u100` (100 sats).
- `sbtc-contract` **source default is the testnet token** (`ST1F7QA2…sbtc-token`), so a
  fresh mainnet deploy reverts every `pay-sbtc` with `u103` until `set-sbtc-contract` is
  called. The live mainnet contract has already been pointed at mainnet sBTC — see
  "Deployed" above.
- `paid-at` is `burn-block-height`.

## `traits.clar`

Minimal fungible-token trait — just `transfer`. sBTC (SIP-010) satisfies it, so
`pay-sbtc` takes any `<ft-trait>` but rejects anything but the configured `sbtc-contract`.

## `mock-sbtc.clar`

SIP-010 mock with a `mint` helper. **Simnet tests only** — never relied on in prod.
(It is also deployed to testnet but unused by the app; harmless.)

## Working on contracts

```bash
cd contracts
clarinet check        # types
npm test              # simnet tests (tests/thread-pay.test.ts)
```

Use TDD: tests assert receipt shape, underpaid/duplicate rejection, token mismatch, and
owner-gating. Keep the `token` string `"STX"`/`"SBTC"` in sync with the TS `Receipt` type
in `frontend/src/lib/receipt.ts`.
