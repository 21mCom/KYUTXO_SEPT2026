# KYUTXO - Bitcoin Metadata Manager

## Overview

KYUTXO is an encrypted, offline-first desktop application designed for managing Bitcoin address and transaction metadata. It enables users to organize cryptocurrency information, attach encrypted files, and manage custom vocabularies, all while prioritizing data privacy through full encryption, password protection, and complete offline functionality. The project's vision is to provide a robust personal crypto data management solution with future expansion into advanced provenance tracking, entity relationship mapping, and compliance reporting. The current focus is on blockchain data import and transaction synchronization.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

KYUTXO employs a security-focused architecture with all data and attachments secured via password-based AES-256-GCM encryption using PBKDF2 key derivation.

The frontend is built with React 18, TypeScript, and Vite, utilizing `shadcn/ui` and Tailwind CSS for a responsive, offline-first UI. State management is handled by TanStack Query and Dexie.js for IndexedDB interactions. The application is packaged for cross-platform desktop deployment using Electron.

The backend uses Express.js with TypeScript primarily for local file attachment management, ensuring core business logic remains client-side to support offline capabilities.

Data is stored locally using Dexie.js (IndexedDB) for structured data, with all sensitive information encrypted.

**Key Architectural Decisions & Features:**

*   **UI/UX:** Responsive, offline-first UI with reorganized navigation, quick action patterns (hover card, side sheet, dropdowns), and branded elements.
*   **Data Model:** Comprehensive records tracking ownership, wallet names, and other metadata.
*   **Encryption:** Full AES-256-GCM encryption at rest for all data and attachments, including re-encryption on password change.
*   **Offline First & Portability:** Designed for complete offline functionality and portable database storage.
*   **Vocabulary Management:** Custom tags, categories, owners, wallet names, seed names, and wallet software with auto-sync.
*   **Duplicate Detection & Merge:** Intelligent merging of new metadata with existing records.
*   **Address Importer (Bulk Import):** Generates addresses from xpub/zpub keys in Singlesig and Multisig modes, with script type selection, M-of-N thresholds, BIP-67 compliance, custom derivation paths, and privacy warnings. Supports vault metadata.
*   **Wallet Data Sync System:** Modular system for importing labels and transaction history from various wallet software, with intelligent duplicate detection and a private key scanner.
*   **Mobile Wallet Import:** Dedicated import page for mobile Bitcoin and Lightning wallets (Phoenix, Wallet of Satoshi, Mycelium). For Lightning wallets, extracts only on-chain transactions (swaps, deposits, withdrawals) that have proper Bitcoin TXIDs, skipping Lightning-only payments. Parses millisatoshi amounts and identifies transaction types via context field.
*   **Descriptor Import:** 3-step wizard for importing Bitcoin addresses from output descriptors (Sparrow wallet export format). Parses `wsh(sortedmulti(...))`, `sh(sortedmulti(...))`, `sh(wsh(sortedmulti(...)))`, and `tr()` (Taproot) formats. Extracts M-of-N threshold, xpubs with fingerprints, and script types. Supports dual-chain (external/internal) address derivation with vault metadata attachment. Taproot support uses x-only pubkey tweaking for accurate bc1p... address derivation. Located at `/descriptor-import`.
*   **BIP-329 Label Import:** Streamlined 3-step wizard for importing BIP-329 standard `.jsonl` files, preserving origin and handling input/output specificity with duplicate detection and private key rejection.
*   **Seed Name Protection:** Prevents accidental seed phrase entry in seed name fields.
*   **Address Verification System:** Confirms address ownership with a tiered importance system.
*   **Historical Price Import:** Imports Bitcoin OHLCV price data from CSV files.
*   **Transaction Sync System:** Fetches and imports confirmed transactions from blockchain data sources for tracked addresses, intelligently matching and creating "Pending Review" records. Captures outpoint data. Includes pause/resume functionality for long-running syncs - paused syncs save progress to IndexedDB and can be resumed later. Resume works best for single-depth syncs; for multi-depth syncs, additional sync runs may be needed after resume to process discovered addresses at higher depths. **Performance optimizations:** Parallel address fetching (6 concurrent requests), address/transaction caches with warmup at sync start, and correct pause/resume bookkeeping using processedRecordIds as master tracking set.
*   **Tor Proxy Integration:** Privacy-enhanced node connectivity via SOCKS5 proxy (Tor Browser/service) with dual-mode routing, Electron IPC handlers, auto-detection, connection testing, .onion support, SSRF protection (URL allowlist), and a trusted local hosts whitelist. **Local network access is opt-in** (disabled by default) to protect users on public WiFi - the `allowLocalNetwork` setting must be explicitly enabled before trusted local hosts are used.
*   **Exact UTXO Tracking:** Dual-mode UTXO calculation (Standard/Exact) with outpoint-based matching for accuracy, data coverage indicators, and historical views.
*   **Record Detail Panel:** Comprehensive metadata display with navigation.
*   **Blockchain Toggle Component:** Filters blockchain-discovered records using optimized indexing.
*   **Reports System:** Includes Source of Funds Report (acquisition history, cost basis, valuation) and Hop-Point Detection Report.
*   **Quick Tagger:** Paste-based bulk tagging tool for addresses and transactions with full metadata support.
*   **Nudgie (Transaction Labeling To-Do):** Workflow for systematically labeling unlabeled transactions.
*   **Database Cleanup:** Dedicated page for querying and bulk deleting blockchain-discovered records without user metadata, with conservative eligibility rules and permanent deletion.
*   **Transaction Classification Metadata:** Tax-neutral fact-recording system for `flowType`, `acquisitionMethod`, `dispositionType`, `costBasisUsd`, and `counterpartyType`.
*   **Bulk Editor:** Batch editing system with filter/action builders, preview, and undo capabilities.
*   **Metadata Conflict Resolution System:** Detects and resolves conflicts for singular metadata fields from multiple import sources, using a `RecordOrigin` system, visual indicators, and a dedicated resolution interface.
*   **Bitcoin Flow Visualizer:** Interactive UTXO provenance tracing tool with Sankey Diagram, Timeline Swimlanes, Line Chart, and Hop-Path Explorer visualizations, prioritizing local data.
*   **Transaction Search Enhancement:** Includes blockchain transactions and participating addresses in search results.
*   **Origin Tracking System:** Comprehensive UTXO lineage tracking with `utxoLineage` and `custodySegment` tables, a Lineage Engine, Continuity Proof component, Continuity Certificate Report, and Evidence Bundle Export.
*   **Timestamp Standards:** `originDate` as Unix seconds (blockTime), `updatedAt` as Unix milliseconds (Date.now()).
*   **Evidence/Document Storage System:** General-purpose encrypted document storage for proof-of-ownership and historical records, supporting various document types and attachments with full encryption.
*   **Vault Management Page:** Dedicated UI for viewing and managing multisig vaults, aggregating addresses, displaying vault details, and providing navigation to filtered records.

## External Dependencies

*   **Local File System:** For storing encrypted attachments.
*   **Google Fonts CDN:** For the Inter font family.
*   **bitcoinjs-lib:** Bitcoin address validation and network detection.
*   **bip32:** HD wallet key derivation.
*   **bip39:** Mnemonic seed phrase handling.
*   **Offline Encryption:** AES-256-GCM encryption with PBKDF2 key derivation.
*   **Electron:** Core framework for desktop application, with security hardening.
*   **electron-builder:** For packaging and distribution.
*   **Radix UI:** Unstyled, accessible component primitives.
*   **Lucide React & React Icons:** Icon libraries.
*   **cmdk:** Command palette component.
*   **class-variance-authority & clsx:** Utilities for dynamic className composition.