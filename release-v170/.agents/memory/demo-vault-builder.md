---
name: Demo vault builder
description: Durable lessons from generating a restorable real-data demo backup outside the app, plus public Esplora scanning and browser-check env gotchas.
---

- Backups can be generated outside the app (plain Node + fflate): write the manifest first, stream tables as NDJSON batches, assign explicit ids and keep cross-table references consistent — restore remaps them. **Why:** the in-app export path needs a live vault; offline generation doesn't.
- `custodySegments.originDate` is Unix **seconds** app-wide (consumers multiply by 1000). Any generator writing ms produces far-future custody dates; assert a sane seconds range in verification, not just row counts.
- An entity-list snapshot placed in the backup's inline settings row (merge mode) auto-applies on restore via the portable-preferences allow-list — no manual import step needed for demo attributions.
- Public Esplora scanning: mempool.space hard-blocks sustained scans (hangs, not 429). Rotate to blockstream.info per retry, cache every GET to disk (resumable), rate-limit and bound concurrency.
- Task containers may lack `chromium` on PATH even when browser checks exist; install it as a Nix system dependency rather than hardcoding /nix/store paths.
- Vault unlock is per full page load: navigate to the target URL first, then unlock there, or the unlock form reappears after `page.goto`.

- Keep chain-adoption targets (CHAIN_TARGET/CHAIN_ADOPT_CAP) high enough that deepOwnedSegments lands well above the build-fail minimum; a zero-margin build breaks on any upstream Esplora/curation drift.

**Deep custody chains:** real adopted addresses rarely pay each other — build 3+ internal hops by chain adoption (adopt the recipient of each owned withdrawal spend, fetch its history, repeat). Two gotchas: (1) the assembly-phase addTx cap (>400 participants) silently drops big spend txs, breaking the custody walk mid-chain — chain adoption must only follow spends under that cap; (2) the segment walk must keep the *deepest* funding outputs per address, not the first N in history order, or shallow fundings crowd out the multi-hop chains.
