# KYUTXO 1.1.29 — Release Notes (draft)

> CI stamps the final patch number from the build run (`1.1.<run number>`), so
> the released version may be higher than .29. Update the heading when the
> release is published. This is the first release since 1.1.28 (May 1) and it
> carries all of the June–July large-vault work.

## The headline: no more freezing on large vaults

If KYUTXO 1.1.24–1.1.28 hung, froze, or "stopped responding" once your vault
grew past a few thousand records, this release is for you. Older builds
re-loaded the entire vault into memory — and decrypted it row by row on the
UI thread — every time you opened a page. The bigger the vault, the longer
the freeze. That architecture is gone:

- **One-time vault format upgrade** — your vault is converted to a new
  storage format that removes the per-row decryption bottleneck entirely.
- **Native read engine (desktop)** — heavy queries (Records, Transactions,
  UTXOs, Balance) run in a background SQLite engine, off the UI thread.
- **Virtualized lists + deferred counts** — pages render the rows you can
  see, immediately; totals fill in behind.
- **Progress everywhere** — launch, unlock, and migration now show live
  progress instead of a frozen-looking spinner.

## What to expect on first launch (important)

The first time you open this version over an existing vault, KYUTXO performs
a **one-time migration**. On large vaults this takes several minutes:

1. **"Upgrading Your Vault"** appears before the unlock screen while the
   database schema is updated. The step name and row counter keep moving.
2. After you unlock, **"Restoring Your Data"** decrypts every legacy row into
   the new format, table by table, with live counts — followed by
   **"Verifying Migrated Data"**, which re-checks every row was restored.
3. When the summary screen reports success, you're done — every later launch
   is a normal fast start.

**Please don't force-quit while the migration is running.** If the app is
closed or interrupted mid-migration anyway, your data is safe: the migration
resumes at the next unlock and nothing is deleted until it has been verified.

## Also in this release

- Unlock no longer blocks on a full-vault scan; startup repairs run in the
  background with visible status.
- Interrupted-migration recovery: a resume banner shows exactly how many rows
  remain, and recovery tools can re-attempt any rows that stay locked.
- Numerous large-vault fixes across Dashboard, Records, Transactions, UTXOs,
  Balance, and Address Checker (no multi-second stalls at 30k+ records in
  our scale tests).

## A note on storage format

The new format stores vault rows in the database without per-field
encryption; your master password still gates access to the app and encrypts
exported backups. For at-rest protection of a portable USB stick, we continue
to recommend encrypting the drive itself (BitLocker/VeraCrypt) as described
in `INSTALL-USB.md`.

## Upgrading a portable (USB) install

1. Download the new `KYUTXO-<version>-Portable.exe`.
2. Copy it into the same folder as your existing `portable` marker file and
   `KYUTXO_Data` folder (next to the old exe).
3. Run the new exe and let the one-time migration finish (see above).
4. Once you've unlocked successfully, delete the old exe.

Tip: back up your USB folder (or export a backup from Settings) before
upgrading — standard practice for any major update.
