# KYUTXO - Bitcoin Metadata Manager

## Overview

KYUTXO is an encrypted, offline-first desktop application for managing Bitcoin address and transaction metadata. It enables users to organize cryptocurrency information, attach encrypted files, and manage custom vocabularies, prioritizing data privacy through full encryption, password protection, and complete offline functionality. The project aims to become a robust personal crypto data management solution, with future plans for advanced provenance tracking, entity relationship mapping, and compliance reporting. The current focus is on efficient blockchain data import and transaction synchronization.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

KYUTXO employs a security-focused architecture with all data and attachments secured via password-based AES-256-GCM encryption using PBKDF2 key derivation. The application is built with React 18, TypeScript, and Vite for the frontend, utilizing `shadcn/ui` and Tailwind CSS for a responsive, offline-first UI, and Electron for cross-platform desktop deployment. State management uses TanStack Query and Dexie.js for IndexedDB. A local Express.js backend primarily manages file attachments, keeping core business logic client-side.

**Key Architectural Decisions & Features:**

*   **UI/UX:** Responsive, offline-first UI with reorganized navigation and quick action patterns.
*   **Data Model:** Comprehensive records for tracking ownership, wallet names, and metadata.
*   **Encryption:** Full AES-256-GCM encryption at rest for all data and attachments, including re-encryption on password change, and a session-level LRU decryption cache.
*   **Offline First & Portability:** Designed for complete offline functionality and portable database storage.
*   **Vocabulary Management:** Custom tags, categories, owners, and wallet details with auto-sync.
*   **Duplicate Detection & Merge:** Intelligent merging of new metadata.
*   **Address Importer:** Bulk import of addresses from xpub/zpub keys, supporting various script types, M-of-N thresholds, BIP-67, and custom derivation paths.
*   **Wallet Data Sync System:** Modular system for importing labels and transaction history from various wallet software, with duplicate detection and a private key scanner. Includes dedicated import for mobile wallets (Phoenix, Wallet of Satoshi, Mycelium), focusing on on-chain transactions.
*   **Descriptor Import:** Wizard for importing Bitcoin addresses from output descriptors (e.g., Sparrow wallet export), supporting `wsh(sortedmulti(...))`, `sh(sortedmulti(...))`, `sh(wsh(sortedmulti(...)))`, and `tr()` formats.
*   **BIP-329 Label Import:** Streamlined import of `.jsonl` files, preserving origin and handling input/output specificity.
*   **Seed Name Protection:** Prevents accidental seed phrase entry.
*   **Address Verification System:** Confirms address ownership with a tiered importance system.
*   **Historical Price Import:** Imports Bitcoin OHLCV price data from CSV files.
*   **Transaction Sync System:** Fetches and imports confirmed transactions from blockchain data sources for tracked addresses, intelligently matching and creating "Pending Review" records. Features pause/resume, performance optimizations (parallel fetching, caching, batched writes), and comprehensive prevout resolution to ensure accurate input addresses and amounts. Includes sync protection with configurable transaction count thresholds, per-address timeouts, and an address blacklist.
*   **Tor Proxy Integration:** Privacy-enhanced node connectivity via SOCKS5 proxy, with auto-detection, connection testing, .onion support, and SSRF protection. Local network access is opt-in.
*   **Electrum Protocol Support:** Alternative, efficient protocol for bulk address syncing (10,000+ addresses) via Electrum JSON-RPC over TCP.
*   **Exact UTXO Tracking:** Dual-mode UTXO calculation (Standard/Exact) with outpoint-based matching.
*   **Record Detail Panel:** Comprehensive metadata display including expandable and lazy-loaded transaction history.
*   **Blockchain Toggle Component:** Filters blockchain-discovered records using optimized indexing.
*   **Reports System:** Includes Source of Funds Report (acquisition history, cost basis, valuation) and Hop-Point Detection Report.
*   **Quick Tagger:** Paste-based bulk tagging tool for addresses and transactions.
*   **Nudgie (Transaction Labeling To-Do):** Workflow for labeling unlabeled transactions.
*   **Database Cleanup:** Dedicated page for querying and bulk deleting blockchain-discovered records without user metadata, offering "Blockchain-Only" and "Discovery Origin" scan modes.
*   **Discovery Tree Dialog:** Visualizes all recursively discovered records from a given address.
*   **Transaction Classification Metadata:** Tax-neutral fact-recording system for `flowType`, `acquisitionMethod`, `dispositionType`, `costBasisUsd`, and `counterpartyType`.
*   **Bulk Editor:** Batch editing system with filter/action builders, preview, and undo.
*   **Value Updater Enhancement:** Extended support for transaction classification fields.
*   **Metadata Conflict Resolution System:** Detects and resolves conflicts for singular metadata fields from multiple import sources using a `RecordOrigin` system.
*   **Bitcoin Flow Visualizer:** Interactive UTXO provenance tracing tool with Sankey Diagram, Timeline Swimlanes, Line Chart, and Hop-Path Explorer visualizations.
*   **Transaction Search Enhancement:** Includes blockchain transactions and participating addresses in search results.
*   **Origin Tracking System:** Comprehensive UTXO lineage tracking with `utxoLineage` and `custodySegment` tables, a Lineage Engine, Continuity Proof, Continuity Certificate Report, and Evidence Bundle Export.
*   **Evidence/Document Storage System:** General-purpose encrypted document storage for proof-of-ownership and historical records.
*   **Vault Management Page:** Dedicated UI for viewing and managing multisig vaults.
*   **Statement Report:** Bank-statement-like transaction report generator with configurable options (date range, currency, balance modes, columns), PDF export, and spending discovery.

## External Dependencies

*   **Local File System:** For storing encrypted attachments.
*   **Google Fonts CDN:** For the Inter font family.
*   **bitcoinjs-lib:** Bitcoin address validation and network detection.
*   **bip32:** HD wallet key derivation.
*   **bip39:** Mnemonic seed phrase handling.
*   **Electron:** Core framework for desktop application.
*   **electron-builder:** For packaging and distribution.
*   **Radix UI:** Unstyled, accessible component primitives.
*   **Lucide React & React Icons:** Icon libraries.
*   **cmdk:** Command palette component.
*   **class-variance-authority & clsx:** Utilities for dynamic className composition.