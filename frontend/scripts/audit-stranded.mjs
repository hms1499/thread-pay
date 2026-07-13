// Read-only audit: find invoices that were PAID on-chain but never delivered.
//
// An invoice is "stranded" when a receipt exists on-chain (money left the user's wallet)
// but status != 'consumed' (they never got a thread). Two flavours:
//   - UNDERPAID : receipt.amount < the quoted price -> /api/generate returns 402 forever,
//                 and the invoice id is burned on-chain (ERR-DUPLICATE-INVOICE), so the
//                 user cannot top up. Money gone.
//   - STUCK     : paid in full, but generation never completed (LLM died, etc).
//
// Writes nothing. Touches no wallet. Safe to run against prod.
//
//   node scripts/audit-stranded.mjs

import { readFileSync } from 'node:fs';
import { fetchCallReadOnlyFunction, Cl, cvToJSON } from '@stacks/transactions';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const CONTRACT = env.NEXT_PUBLIC_CONTRACT;
const NETWORK = env.NEXT_PUBLIC_STACKS_NETWORK || 'testnet';
const [contractAddress, contractName] = CONTRACT.split('.');

console.log(`network=${NETWORK}  contract=${CONTRACT}\n`);

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

// Every invoice that never reached 'consumed' is a candidate. Most will simply be
// unpaid abandoned quotes; the on-chain receipt is what separates those from real losses.
const candidates = await sb(
  'invoices?status=neq.consumed&select=invoice_id,service_id,status,price_stx,price_sbtc,created_at,variant_tones&order=created_at.desc',
);
const total = await sb('invoices?select=invoice_id');
console.log(`invoices total=${total.length}  not-consumed=${candidates.length}`);
console.log('checking each not-consumed invoice for an on-chain receipt...\n');

const stranded = [];
let checked = 0;

for (const inv of candidates) {
  const cv = await fetchCallReadOnlyFunction({
    contractAddress,
    contractName,
    functionName: 'get-receipt',
    functionArgs: [Cl.bufferFromHex(inv.invoice_id)],
    network: NETWORK,
    senderAddress: contractAddress,
  });
  const json = cvToJSON(cv);
  checked++;
  process.stdout.write(`\r  ${checked}/${candidates.length}`);

  if (!json.value) continue; // (none) -> never paid, just an abandoned quote. Fine.

  const f = json.value.value;
  const receipt = {
    payer: f.payer.value,
    amount: BigInt(f.amount.value),
    token: f.token.value,
    paidAt: f['paid-at'].value,
  };
  const required = receipt.token === 'STX'
    ? BigInt(inv.price_stx)
    : BigInt(inv.price_sbtc);

  stranded.push({
    ...inv,
    ...receipt,
    required,
    kind: receipt.amount < required ? 'UNDERPAID' : 'STUCK',
  });
}

console.log('\n');

if (stranded.length === 0) {
  console.log('✅ 0 stranded invoices. Nobody paid without being served.');
  process.exit(0);
}

const owed = { STX: 0n, SBTC: 0n };
console.log(`⚠️  ${stranded.length} STRANDED (paid on-chain, never delivered)\n`);
for (const s of stranded) {
  owed[s.token] += s.amount;
  const unit = s.token === 'STX' ? 1_000_000n : 100_000_000n;
  const fmt = (v) => `${Number(v) / Number(unit)} ${s.token}`;
  console.log(
    `  [${s.kind}] ${s.invoice_id.slice(0, 12)}…  ${s.service_id}  status=${s.status}\n` +
    `      payer   ${s.payer}\n` +
    `      paid    ${fmt(s.amount)}   quoted ${fmt(s.required)}` +
      (s.variant_tones ? `  (multi-tone x${s.variant_tones.length})` : '') + '\n' +
    `      at      ${s.created_at}\n`,
  );
}

console.log('TOTAL OWED BACK TO USERS:');
if (owed.STX) console.log(`  ${Number(owed.STX) / 1e6} STX`);
if (owed.SBTC) console.log(`  ${Number(owed.SBTC) / 1e8} sBTC`);
console.log('\nRefund by sending from the treasury wallet back to each payer above.');
