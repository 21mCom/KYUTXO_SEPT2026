# KYUTXO - Bitcoin Metadata Manager

## Overview
KYUTXO is an offline-first desktop application designed for managing Bitcoin address and transaction metadata. Its primary purpose is to help users organize cryptocurrency information, attach relevant files, and manage custom vocabularies, all while prioritizing data privacy. The application operates completely offline and includes a password-based UI locking mechanism. KYUTXO aims to become a comprehensive personal crypto data management solution, with future ambitions including advanced provenance tracking, entity relationship mapping, and compliance reporting. The immediate focus is on efficient blockchain data import and transaction synchronization.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture
KYUTXO features an offline-first architecture built for cross-platform desktop deployment using Electron. The frontend is developed with React 18, TypeScript, and Vite, leveraging `shadcn/ui` and Tailwind CSS for a responsive user interface. State management is handled by TanStack Query and Dexie.js for IndexedDB. A local Express.js backend primarily serves file attachments, with core business logic residing client-side.

**Key Architectural Decisions & Features:**

*   **UI/UX:** Responsive, offline-first interface with streamlined navigation.
*   **Data Model:** Comprehensive records for tracking ownership, wallet names, and metadata.
*   **Security:** Implements a password-based UI lock (hash check only); data is stored as plaintext in IndexedDB. Users requiring data-at-rest protection should utilize OS-level encrypted containers.
*   **Performance:** Heavy pages (Transactions, Bulk Editor, Quick Tagger, UTXOs, Dusted) use DB-level filtering, indexed lookups (e.g. `inputStringLower` for O(1) case-insensitive record search), batched/iterative scanning, and virtual scrolling (@tanstack/react-virtual) instead of loading records into memory. Search is debounced; per-page pending opacity is configurable via `PAGE_SEARCH_PENDING_OPACITY` in `client/src/config/debounce.ts`.
*   **Offline First & Portability:** Designed for full offline functionality and portable database storage.
*   **Data Management:** Includes features for custom vocabulary management, duplicate detection and merging, and bulk address/descriptor/BIP-329 label importing.
*   **Wallet Data Sync:** Modular system for importing labels and transaction history from various wallet software, including mobile wallets, with duplicate detection.
*   **Transaction Sync System:** Fetches and imports confirmed transactions from blockchain sources for tracked addresses, intelligently matching and creating "Pending Review" records. Features include pause/resume, parallel fetching, caching, batched writes, and prevout resolution.
*   **Privacy & Connectivity:** Supports Tor proxy integration for privacy-enhanced node connectivity and Electrum Protocol for efficient bulk address syncing.
*   **UTXO Tracking:** Offers dual-mode UTXO calculation (Standard/Exact) with outpoint-based matching, per-output dust flagging, and a "Hide dust" filter.
*   **Reporting & Analysis:** Includes a Source of Funds Report, Hop-Point Detection Report, Statement Report, Privacy Audit (on-chain vulnerability scanner with an Adversary View exposure panel), Quantum Risk Scanner, and a Balance Overview.
*   **Visualization:** Features a Bitcoin Flow Visualizer for UTXO provenance tracing and a Network Analysis tool for visualizing Bitcoin address relationships as a force-directed graph.
*   **Workflow Tools:** Provides a Quick Tagger for bulk labeling, Nudgie for unlabeled transaction workflow, a Database Cleanup utility for managing blockchain-discovered records, and a Discovery Tree Dialog.
*   **Metadata & Editing:** Supports transaction classification metadata, a bulk editor for batch modifications, and a metadata conflict resolution system using a `RecordOrigin` system.
*   **Origin Tracking System:** UTXO lineage tracking via the `utxoLineage` and `custodySegments` tables, a Lineage Engine, Continuity Proof, Continuity Certificate Report, and Evidence Bundle Export. Partial export bundles persist to IndexedDB (`partialExportBundles` table, managed by `client/src/lib/data/partialBundleStore.ts`); the lineage-build cancel threshold is configurable via Settings > Lineage Build (`settings.cancelConfirmThreshold`, default 75%).
*   **Privacy Entity List:** The Privacy Audit matches participant addresses against a bundled offline dataset (`client/src/lib/privacy-entity-list.ts`, compiled from WalletExplorer, GraphSense TagPacks, OFAC SDN). Users can import a validated JSON snapshot via Settings > Privacy Audit Entity List (persisted to `settings.entityListSnapshot`, re-applied at startup), export the current list, or revert to the bundled fallback; persistence + validation live in `client/src/lib/data/entity-list-store.ts`. No network access is ever added.
*   **Evidence Storage:** General-purpose document storage for proof-of-ownership and historical records.
*   **Vault Management:** Dedicated UI for viewing and managing multisig vaults.

## Data Layer Conventions

Every guard below is a registered validation step; several also run in the git pre-commit hook (reinstall via `scripts/install-hooks.sh`). The `check-*-browser.mjs` guards drive a REAL headless Chromium (need `chromium` on PATH via Nix + `playwright-core`, no browser download; they reuse the dev server or spawn one) because Node/jsdom simulations give false results for what the live Vite bundle actually does. Deep implementation detail lives in each check script.

*   **CRUD Layer Guards** (`crud-guards`, `node scripts/check-crud-guards.js`): Write operations on the tables below must go through their dedicated CRUD modules (re-exported via `dataFacade.ts`); direct writes elsewhere are prohibited. Database migrations in `database.ts` that use `tx.table(...)` are exempt.
    *   `db.records` → `client/src/lib/data/record-crud.ts`
    *   `db.blockchainTransactions` → `client/src/lib/data/transaction-crud.ts`
    *   `db.transactionParticipants` → `client/src/lib/data/transaction-crud.ts`
    *   `db.utxoLineage` → `client/src/lib/data/lineage-crud.ts`
    *   `db.custodySegments` → `client/src/lib/data/lineage-crud.ts`
    *   `db.evidence` → `client/src/lib/data/evidence-crud.ts`
    *   `db.evidenceAttachments` → `client/src/lib/data/evidence-crud.ts`
    *   `db.lineageSnapshots` → `client/src/lib/data/lineage-crud.ts`
*   **Safe Note Rendering Guard** (`note-rendering`, `node scripts/check-note-rendering.js`): Every free-text note surface (record/cosigner/evidence/metadata-source/Nudgie notes, report finding descriptions + remediation, source citation notes, entity-list conflict diffs) must render through `renderSourceNote` (`client/src/lib/renderSourceNote.tsx`), which never linkifies dangerous URI schemes (`javascript:`, `data:`, `file:`, `vbscript:`). The scan flags `.notes`/`.sourceNote` fields rendered directly as JSX children.
*   **No External Resources Guard** (`no-external-resources`, `node scripts/check-no-external-resources.js`): No external CDN/script/style/font links may ship — the scan covers `client/index.html` and the built `dist/public` output (run `npm run build` first to include it). The Electron CSP `connect-src` runtime endpoints (`mempool.space`, `blockstream.info`) are allow-listed.
*   **Test Provider Harness Guard** (`test-providers`, `node scripts/check-test-providers.js`): Tests rendering tooltip-capable components (AddressLink, TxidLink, etc.) must use the shared harness `renderWithProviders`/`TestProviders` (`client/src/test/testProviders.tsx`) — bare or partial provider wrappers throw at runtime. Intentional-mock tests are allow-listed via `ALLOWED_FILES` in the script.
*   **No Buffer Global Guard** (`no-buffer-global`, `node scripts/check-no-buffer-global.js`): Browser-side `client/src` code must never use the Node `Buffer` global — it passes unit tests (vitest runs in Node) but crashes in the real browser bundle, which doesn't polyfill it. Use `Uint8Array` end to end plus `atob`/`btoa` or `base64ToBuffer` in `client/src/lib/crypto.ts`; the escape hatch is an explicit `import { Buffer } from 'buffer'`.
*   **Proof Verification Browser Guard** (`proof-verify-node-check` vitest + `proof-verify-browser-check`, `node scripts/check-proof-verify-browser.mjs`): `runProofVerificationBrowserCheck` (`client/src/lib/proofVerificationBrowserCheck.ts`) exercises the real BIP-322 signature-verification path (valid, tampered, and wrong-message proofs) in a real Chromium and fails unless it verifies correctly with no `Buffer` global present.
*   **PDF Glyph Rendering Browser Guard** (`pdf-glyph-node-check` vitest + `pdf-glyph-browser-check`, `node scripts/check-pdf-glyph-browser.mjs`): `runPdfGlyphBrowserCheck` (`client/src/lib/pdfGlyphBrowserCheck.ts`) generates a PDF through the real `sanitizePdfText` path and re-parses it with pdf.js to prove remapped WinAnsi glyphs (em-dash, curly quotes, etc.) round-trip in a real viewer. pdf.js's *legacy* build is used because the Nix-pinned test Chromium (v125) lacks `Promise.try`; real users run a modern Electron Chromium.
*   **Sample PDF Browser Guard** (`sample-pdf-browser-check`, `node scripts/check-sample-pdf-browser.mjs`): Drives the real Proof-of-Funds "Generate Sample PDF" button in Chromium and re-parses the download to prove the SPECIMEN watermark appears on every page, the sample notice banner renders, optional sections survive, and no real SHA-256 fingerprint is ever embedded in a specimen.
*   **Dust Badge + Audit Downgrade Browser Guard** (`dust-badge-audit-browser-check`, `node scripts/check-dust-badge-audit-browser.mjs`): Proves the three dust surfaces are wired together end to end in Chromium: Dusted page "Mark as dust" → UTXOs page group and per-UTXO Dust badges → Privacy Audit downgraded LOW finding ("already marked as dust by you") with no non-downgraded dust finding remaining.
*   **Privacy Audit Flows Browser Guard** (`privacy-audit-flows-browser-check`, `node scripts/check-privacy-audit-flows-browser.mjs`): Proves the post-split Privacy Audit subcomponents still work end to end in Chromium: seeds a Whirlpool-pattern CoinJoin, opens the transaction deep-dive dialog from the finding card, asserts the Boltzmann link-probability heatmap renders the exact input×output cell grid and the CoinJoin Sankey SVG is visible, then downloads the Privacy History CSV (header + recorded score + CoinJoin column) and PDF (`%PDF` magic) exports. Peel Chain graph/list toggling is covered by `PrivacyAudit.peelList.test.tsx` (vitest).
*   **Adversary View Browser Guard** (`adversary-view-browser-check`, `node scripts/check-adversary-view-browser.mjs`): Drives a full Privacy Audit run in Chromium against a seeded co-spend and asserts the Adversary View panel appears, its transient loading status was observed, the summary stats and exposure badges match the seed exactly, and the no-XPUB degradation banner shows.
*   **PDF Text Sanitization Guard** (`pdf-text-sanitized`, `node scripts/check-pdf-text-sanitized.js`): Every string reaching a jsPDF text sink (`doc.text`/`doc.cell`, `autoTable` head/body) must be wrapped in `sanitizePdfText(...)` (`client/src/lib/pdfText.ts`) — jsPDF's Standard-14 Helvetica garbles anything above WinAnsi. The static scan flags unwrapped non-ASCII and bare member expressions; the escape hatch for a genuine false positive is `ALLOWED_LINES` in the script.

## External Dependencies
*   **Local File System:** Used for storing attachments with SHA-256 hashed identifiers and opaque filenames.
*   **Bundled Fonts:** Inter and JetBrains Mono are self-hosted via `@fontsource-variable` and bundled with the app (no external font CDN) for full offline use.
*   **bitcoinjs-lib:** Bitcoin address validation and network detection.
*   **bip32:** HD wallet key derivation.
*   **bip39:** Mnemonic seed phrase handling.
*   **Electron:** Core framework for desktop application development.
*   **electron-builder:** For packaging and distributing the desktop application.
*   **Radix UI:** Provides unstyled, accessible component primitives.
*   **Lucide React & React Icons:** Icon libraries.
*   **cmdk:** Command palette component.
*   **class-variance-authority & clsx:** Utilities for dynamic className composition.
