---
name: Address Checker 5k-row scaling
description: What actually limits a 5,000-address check — network shape vs render freezes — and how the live/e2e verification is split.
---

**Rule:** For huge result tables, per-flush React cost dominates over network once lookups are concurrent — memoized rows + page-scroll virtualization (repo's VirtualizedUtxoList pattern) are both required; memoization alone still leaves a multi-second freeze at the initial 5,000-row mount (mounting one Radix Tooltip per row is the biggest single cost — prefer native `title` for high-volume cells).

**Why:** A real-browser 5k run measured ~9.5 s main-thread freezes per 250 ms flush and 12.5 s Stop lag before the fix; after memo+virtualization worst long task was ~130 ms and Stop ~200 ms.

**How to apply:** Verification is split in two: `scripts/bench-address-checker-live.mjs` drives the REAL electron/electrum-client.cjs pool from Node against a live Electrum server (fake ipcMain captures handlers; PHASE/SLICE env splits the run into <5-min resumable chunks with deterministic sha256-counter addresses since bg jobs and >5-min shells die); `scripts/check-address-checker-5k-browser.mjs` (validation-gated) shims window.electronAPI with a Proxy (unknown methods → generic failure) to pin render responsiveness, Stop, and result retention. Live numbers (blockstream electrs): new path ≈86 ms/addr vs old sequential ≈270 ms/addr → ~3.1×; batch-history phase is still sequential inside batches and dominates. Public servers may refuse new handshakes for ~30 s after a few thousand rapid requests — retry, it's throttling, not breakage.
