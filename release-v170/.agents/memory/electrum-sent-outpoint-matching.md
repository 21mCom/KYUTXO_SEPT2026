---
name: Electrum sent via outpoint matching
description: Why computing "sent/spent" for an address from Electrum txs by input address is always 0, and the correct outpoint-matching approach.
---

# Computing an address's Sent/Spent total from transaction lists

**Rule:** To compute how much an address has *sent*, never sum inputs whose
`vin[].prevout.scriptpubkey_address === address`. Instead build the set of
outpoints that *paid to* the address (`${txid}:${vout.n}` → value from every
output where `scriptpubkey_address === address`), then sum any input whose
`${vin.txid}:${vin.vout}` is in that set.

**Why:** Electrum verbose transactions do **not** carry prevout addresses on
inputs (only Esplora enriches `vin[].prevout`). So address-matching inputs
yields **0 sent**, which makes the displayed balance wrong. This was a real
user-reported bug in the Address Checker. The full address history (Electrum
`get_history`, Esplora `/txs`) always contains every funding tx, so the
owned-outpoint set is complete and the match is exact.

**How to apply:** Use the shared pure helper
`client/src/lib/providers/address-history.ts` → `computeHistoryFromTxs(address, txs)`
for any "received/sent/first-seen/last-seen from a tx list" computation. It is
confirmed-only (matches Esplora `chain_stats`). The Electrum provider's
`getAddressHistoryDates` and the Address Checker's fallback derivation both call
it — keep new call sites on it rather than re-deriving inline.

**Tx-set discovery too:** address-keyed participant loads also miss whole spend TXS (not just amounts) when the only owned link is a blank-address input. Use the shared `getParticipantsByAddressesWithOutpointSpends` helper for "txs involving my addresses" discovery. And hop/graph builders that key edges by participant address need an explicit outpoint→owner edge for blank-address inputs or the spend tx is unreachable even when it's in the tx set (AML hop walk).

**Discovery helper vs attribution:** `getParticipantsByAddressesWithOutpointSpends` only MERGES blank-address spend-input rows — it never rewrites their address. Any consumer that gates on "participant.address is one of my addresses" (nudge candidates, reuse detection, CIO) must also attribute blank inputs to the owner via a `prevTxid:prevVout → owner address` map, or the discovered spend rows are silently filtered right back out.
