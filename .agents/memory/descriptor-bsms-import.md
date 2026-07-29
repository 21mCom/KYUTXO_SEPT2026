---
name: Descriptor/BSMS import gotchas
description: BSMS unified /** wildcard handling, single-sig BSMS routing, and vocabulary "already exists" killing bulk saves
---

- BSMS-spec descriptors use a unified `/**` wildcard per key (not `/<0;1>/*`). Descriptor key parsing must treat a cleaned chain path of `**` as standard dual-chain with empty derivationPath, or derivation misbehaves and users never reach the metadata step.
- `parseBSMS` accepts single-sig `wpkh(`/`pkh(` descriptors, but the multisig descriptor parser rejects them confusingly; a dedicated early guard should redirect users to the Address Importer. The guard regex must not match `wsh(`/`sh(wsh(`.
- All descriptor-import entry points (file drop, paste, Sparrow JSON) should route through `analyzeDescriptorInput` in `descriptor-import-utils.ts` — do not re-add per-handler parse logic.

**Vocabulary creates in bulk save paths:** `createOwner`/`createWalletName`/`createSeedName`/`createWalletSoftware` (vocabulary-crud) throw "X already exists" on duplicates, and the `existing*` hook lists can lag the DB (e.g. an entry created moments earlier in the same flow). Any bulk save that pre-creates vocabulary must catch-and-ignore /already exists/i, or one duplicate aborts the entire import with a "Save failed" toast.

**Why:** found via real-browser e2e — unit tests with mocked hooks never hit it.
**How to apply:** wrap vocabulary create calls in a tolerant helper in any import/bulk-edit save path; verify import flows in a real browser (`scripts/check-descriptor-bsms-import-browser.mjs` is the working harness, incl. re-lock-after-navigation unlock loop).
