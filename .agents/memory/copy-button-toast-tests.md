---
name: Copy-button toast guard tests
description: How to reliably assert a copy button's success/destructive toast on pages that also fire other toasts
---

# Copy-button toast guard tests

These pages wire each inline "copy" button to BOTH a `navigator.clipboard.writeText`
call and a success/destructive toast (the "Copy failed" destructive toast). To
guard that contract in vitest:

- Set `navigator.clipboard = { writeText }` via `Object.defineProperty(navigator,
  "clipboard", { configurable: true, value: { writeText } })`; use a resolving
  `vi.fn()` for success and `mockRejectedValue` for the failure case. Restore the
  original in a `finally`.
- Some copy helpers (e.g. SettingsPage `copyTextToClipboard`) fall back to
  `document.execCommand("copy")` when `writeText` rejects. To force the destructive
  toast you must ALSO stub `document.execCommand` to return false, or the fallback
  silently "succeeds" and no failure toast fires.

**Pitfall — toast pollution.** Many of these pages fire OTHER toasts during setup
(invalid-snapshot validation toast on entity-list import; "QR Code Detected" toast
on scan). If you assert `toastMock` right after setup, those leak in and break
`not.toHaveBeenCalledWith({ variant: "destructive" })` style assertions.

**Why:** the import/scan toast can itself be destructive, so the success-case
"no destructive toast" assertion fails on the unrelated toast.

**How to apply:** call `toastMock.mockClear()` immediately BEFORE clicking the copy
button (after all setup), so assertions only see the copy button's own toast.

Already-covered copy buttons (do not duplicate): TxidLink / RecordDetailPanel
tx-history / UTXOs CopyTxidButton (`copy-txid-confirmation.test.tsx`), shared
AddressLink/TxidLink/BitcoinAddressDisplay (`copy-button-toast.test.tsx`),
PrivacyAudit peel-chain (`PrivacyAudit.peelGraphActions.test.tsx`).
