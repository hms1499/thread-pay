// The example thread shown on a cold landing, before anything is generated.
//
// This is hand-written marketing copy, NOT a live generation and NOT a real user's
// thread: it must render instantly, identically, offline, and without spending an LLM
// call or exposing someone else's content. It is labelled as an example in the UI.
//
// It exists because the landing page used to greet a stranger with an empty easel — a
// generator that never showed what it generates. Whoever edits this is editing the first
// thing a cold visitor reads, so keep it genuinely good: it is the product demo.
//
// Topic and tone are deliberately crypto-native (educational), because that is where the
// traffic comes from.

export const SAMPLE_TOPIC = 'Why Bitcoin’s 21M cap actually matters';
export const SAMPLE_TONE = 'educational';
export const SAMPLE_TOTAL = 8;

// The opening tweets. Only these are shown — enough to prove quality, short enough to
// stay above the fold, and it leaves the rest as a reason to try it.
export const SAMPLE_THREAD: string[] = [
  'Everyone says “Bitcoin is scarce.” Almost nobody can explain why that’s different from gold being scarce.\n\nThe answer is more interesting than you think. 🧵',
  'Gold is scarce because it’s hard to find.\n\nBitcoin is scarce because it’s impossible to make more.\n\nThose are not the same thing. One is a supply constraint. The other is a supply guarantee.',
  'If gold 10x’d tomorrow, miners would dig harder, open new mines, and supply would rise.\n\nThat’s how every commodity in history has worked: higher price → more supply → price settles back down.',
];
