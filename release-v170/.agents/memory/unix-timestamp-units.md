---
name: Unix timestamp unit contracts
description: Which stored timestamp fields are seconds vs milliseconds, and the shared helpers to use.
---
Stored blockchain fields (blockchainTransactions.blockTime, utxoLineage.blockTime, CustodySegment.originDate) are Unix SECONDS; app-side fields (createdAt/updatedAt, statsComputedAt, addressSyncState.lastSyncedAt) are Date.now() MILLISECONDS.

**Why:** feeding seconds into date-fns/new Date renders 1970; feeding ms into a seconds-based formatter (e.g. proof-of-funds formatUnix, BalanceSummary.timestamp contract) renders far-future dates — both shipped as real bugs.

**How to apply:** render seconds fields via `client/src/lib/unix-seconds.ts` (unixSecondsToDate/formatUnixSeconds — return null/"Unknown" for 0/missing block times, never the epoch; msToUnixSeconds for ms→s). Any new surface mixing the two must state its unit contract in a comment and use these helpers instead of ad-hoc `* 1000`.
