---
name: Test provider harness
description: Why component/page tests must wrap in the full provider stack, and where the shared harness lives.
---

# Shared test provider harness

Use `renderWithProviders` / `TestProviders` from `@/test/testProviders` (full
stack: ActivityBusProvider -> TooltipProvider -> RecordPreviewProvider) for any
test that mounts a component capable of rendering an AddressLink/TxidLink
(needs RecordPreviewProvider via `useRecordPreview`) or a Radix Tooltip
(needs TooltipProvider).

**Why:** Radix Tooltip v1.x throws "must be used within TooltipProvider" at
render time, and AddressLink throws without RecordPreviewProvider. Many
components render these only *conditionally* (e.g. HopPathExplorer's explore
button only when `onExploreAddress` is passed; RecordTable via
BitcoinAddressDisplay), so a bare `render(<X/>)` passes today but silently
unmounts the tree the moment a future UI tweak always mounts the link/tooltip.

**How to apply:** Prefer the full harness over a bare render or a partial
inline `<TooltipProvider>` wrapper. The provider stack is jsdom-safe even
without fake-indexeddb (RecordPreviewProvider's custom-field effect swallows the
Dexie error). `settingsTestProviders.tsx` is now just a back-compat alias
(`SettingsTestProviders`/`renderWithSettingsProviders`) re-exporting the general
names — do not reintroduce a Settings-specific copy.

**Guard:** `scripts/check-test-providers.js` (validation step `test-providers`,
also in the pre-commit hook) flags any `*.test.tsx?` under `client/src` that
renders a `<TooltipProvider>` JSX tag without also rendering a
`<RecordPreviewProvider>` — i.e. a bare TooltipProvider. Inlining BOTH providers
passes (it's a complete stack), so the 9 PrivacyAudit/AddressReuse tests that
manually wrap both are fine. Intentional-mock tests that `vi.mock` the context
(copy-button-toast{,-extra}, copy-txid-confirmation) are allow-listed via
`ALLOWED_FILES` in the script. To detect the fragile case it keys on presence of
RecordPreviewProvider, not the harness import, so manual full stacks aren't
false-flagged.
