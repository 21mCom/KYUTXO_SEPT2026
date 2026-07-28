---
name: Electrum txid confirmations
description: Electrum verbose transaction fetches carry confirmations but no block height — derive height from a cached chain tip; never cache unconfirmed conversions.
---

# Electrum txid-driven fetches: confirmations, not heights

**Rule:** Electrum's verbose `blockchain.transaction.get` response (Bitcoin Core shape) reports `confirmations` relative to the server's tip but NEVER a block height. Per-transaction heights exist only in address-history entries (`blockchain.scripthash.get_history`). A txid-driven fetch must derive `height = tip − confirmations + 1` from a chain-tip lookup; hardcoding height 0 marks every fetched tx unconfirmed.

**Why:** This caused the never-converging startup rebuild: every txid-fetched orphan was reported unconfirmed, the backfill skipped all of them, nothing was written, and the same orphans were re-detected every launch.

**How to apply:**
- Cache the tip briefly (~60s TTL) and dedup concurrent lookups so batch runs pay one tip round-trip, not one per tx. Piggyback: let `getBlockHeight()` prime the cache (the backfill probes it up front).
- Zero/missing/negative confirmations, tip-fetch failure, or derived height ≤ 0 → report unconfirmed (never throw: prevout resolution reuses the same fetch and only needs vout data).
- Session-long provider transaction caches must never store unconfirmed conversions — a pinned "unconfirmed" poisons every later consumer (including the address-history path sharing the cache). Also bypass cached-unconfirmed on read so a tx that confirms mid-session gets fresh status.
- Derived heights can drift −1 if a block arrives between tip caching and the server computing confirmations; treat derived heights as approximate by one block.
- The min-confirmations guard `tip − height` undercounts by 1 (true count is `tip − height + 1`); pre-existing and consistent across providers — change everywhere or nowhere.
