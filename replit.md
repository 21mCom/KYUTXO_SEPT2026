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
*   **Performance:** Utilizes DB-level and cursor-based pagination, indexed lookups (including `inputStringLower` for O(1) case-insensitive record search), and debounced search for efficient data handling. Transactions page uses iterative batched scanning to search across the entire database without caps, yielding between batches to keep the UI responsive; search results use virtual scrolling (@tanstack/react-virtual) with on-demand participant data loading for visible items, replacing pagination for smooth scrolling through up to 50,000 matches. Bulk Editor uses database-level filtering with index-optimized queries instead of loading records into memory, and virtual scrolling for both the preview list and confirmation dialog to keep the UI smooth with up to 10,000+ matching records. Quick Tagger uses virtual scrolling for its review table (supporting 1000+ pasted entries) and targeted `inputString` index lookups instead of loading all records. UTXOs page uses virtual scrolling with a flattened row model (address groups + expanded UTXOs) instead of pagination, allowing smooth scrolling through all addresses. Descriptor Import uses targeted `inputString` index lookups.
*   **Offline First & Portability:** Designed for full offline functionality and portable database storage.
*   **Data Management:** Includes features for custom vocabulary management, duplicate detection and merging, and bulk address/descriptor/BIP-329 label importing.
*   **Wallet Data Sync:** Modular system for importing labels and transaction history from various wallet software, including mobile wallets, with duplicate detection.
*   **Transaction Sync System:** Fetches and imports confirmed transactions from blockchain sources for tracked addresses, intelligently matching and creating "Pending Review" records. Features include pause/resume, parallel fetching, caching, batched writes, and prevout resolution.
*   **Privacy & Connectivity:** Supports Tor proxy integration for privacy-enhanced node connectivity and Electrum Protocol for efficient bulk address syncing.
*   **UTXO Tracking:** Offers dual-mode UTXO calculation (Standard/Exact) with outpoint-based matching.
*   **Reporting & Analysis:** Includes a Source of Funds Report, Hop-Point Detection Report, Statement Report, Privacy Audit (on-chain vulnerability scanner), Quantum Risk Scanner, and a Balance Overview.
*   **Visualization:** Features a Bitcoin Flow Visualizer for UTXO provenance tracing and a Network Analysis tool for visualizing Bitcoin address relationships as a force-directed graph.
*   **Workflow Tools:** Provides a Quick Tagger for bulk labeling, Nudgie for unlabeled transaction workflow, a Database Cleanup utility for managing blockchain-discovered records, and a Discovery Tree Dialog.
*   **Metadata & Editing:** Supports transaction classification metadata, a bulk editor for batch modifications, and a metadata conflict resolution system using a `RecordOrigin` system.
*   **Origin Tracking System:** Comprehensive UTXO lineage tracking with `utxoLineage` and `custodySegment` tables, a Lineage Engine, Continuity Proof, Continuity Certificate Report, and Evidence Bundle Export. Partial export bundles are persisted to IndexedDB (`partialExportBundles` table) so they survive page refreshes; the `partialBundleStore.ts` module provides save/load/clear operations keyed by the sorted set of selected segment IDs.
*   **Evidence Storage:** General-purpose document storage for proof-of-ownership and historical records.
*   **Vault Management:** Dedicated UI for viewing and managing multisig vaults.

## Data Layer Conventions
*   **CRUD Layer Guards:** Write operations on the following tables must go through their dedicated CRUD modules (re-exported via `dataFacade.ts`). Direct writes outside the CRUD module are prohibited. This constraint is enforced automatically via a git pre-commit hook and a registered validation step (`crud-guards`). Run `scripts/install-hooks.sh` to reinstall the pre-commit hook after cloning. Database migrations in `database.ts` that use `tx.table(...)` are exempt. Run `node scripts/check-crud-guards.js` to manually verify compliance.
    *   `db.records` → `client/src/lib/data/record-crud.ts`
    *   `db.blockchainTransactions` → `client/src/lib/data/transaction-crud.ts`
    *   `db.transactionParticipants` → `client/src/lib/data/transaction-crud.ts`
    *   `db.utxoLineage` → `client/src/lib/data/lineage-crud.ts`
    *   `db.custodySegments` → `client/src/lib/data/lineage-crud.ts`
    *   `db.evidence` → `client/src/lib/data/evidence-crud.ts`
    *   `db.evidenceAttachments` → `client/src/lib/data/evidence-crud.ts`
    *   `db.lineageSnapshots` → `client/src/lib/data/lineage-crud.ts`

## External Dependencies
*   **Local File System:** Used for storing attachments with SHA-256 hashed identifiers and opaque filenames.
*   **Google Fonts CDN:** For the Inter font family.
*   **bitcoinjs-lib:** Bitcoin address validation and network detection.
*   **bip32:** HD wallet key derivation.
*   **bip39:** Mnemonic seed phrase handling.
*   **Electron:** Core framework for desktop application development.
*   **electron-builder:** For packaging and distributing the desktop application.
*   **Radix UI:** Provides unstyled, accessible component primitives.
*   **Lucide React & React Icons:** Icon libraries.
*   **cmdk:** Command palette component.
*   **class-variance-authority & clsx:** Utilities for dynamic className composition.