---
name: Combobox create-new wording convention
description: The app-wide convention for "select or add" combobox new-entry rows, and how a shared component drifted from it.
---

Every inline "select or add" combobox in this app (Owner, Wallet Name, Seed Name, Wallet Software — in QuickTagger.tsx, DescriptorImport.tsx, and the value-updater flow) labels its create-new-entry row `Add "<value>"`, with a `Plus` icon and (where present) an "Add new" `CommandGroup` heading.

The shared `VocabularyCombobox` (client/src/components/VocabularyCombobox.tsx), introduced later to consolidate Wallet Import's four pickers, independently used `Create "<value>"` / "Creating..." / "Create new" instead. Several browser checks (e.g. check-wallet-import-reattribution-browser.mjs, check-metadata-sources-dedup-browser.mjs) locate the create-new `[cmdk-item]` by matching the text `Add "<name>"`, per the established convention — so the wording drift made those `[cmdk-item]` text-based locators time out after 30s with no match, even though the component worked functionally.

**Why:** text-matching Playwright locators against a `CommandItem`'s visible label are a real assertion of UI wording, not implementation detail — two independently-written checks agreeing on `Add "..."` reflects a genuine app-wide convention, not a coincidence to paper over in the checks.

**How to apply:** when adding or touching any "select or add" combobox (shared or inline), use `Add "<value>"` for the create-new item's visible text (and "Add new" for its group heading, "Adding..." for the pending state) to match the rest of the app. Prefer clicking these items in tests via a stable `data-testid` (e.g. `option-create-new-<fieldKey>`) rather than the label text where possible, but keep the label text itself convention-compliant since other checks/users read it directly.
