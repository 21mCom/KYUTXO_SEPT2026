# KYUTXO - Bitcoin Metadata Manager

## Overview

KYUTXO is a secure, offline-first encrypted desktop application for managing cryptocurrency metadata. It allows users to organize information about Bitcoin addresses and transactions, attach encrypted files, and manage custom vocabularies. The project prioritizes data privacy through full encryption at rest, password-protected access, and complete offline functionality. It aims to provide a robust solution for personal crypto data management, with future ambitions including advanced provenance tracking, entity relationship mapping, and tax/compliance reporting. The project is currently focused on blockchain data import and transaction synchronization.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

KYUTXO employs a security-focused architecture with all data and attachments secured via password-based AES-256-GCM encryption using PBKDF2 key derivation.

The frontend is built with React 18, TypeScript, and Vite, utilizing `shadcn/ui` and Tailwind CSS for a responsive, offline-first UI. State management is handled by TanStack Query and Dexie.js for IndexedDB interactions. The application is packaged for cross-platform desktop deployment using Electron.

The backend uses Express.js with TypeScript primarily for local file attachment management, ensuring core business logic remains client-side to support offline capabilities.

Data is stored locally using Dexie.js (IndexedDB) for structured data, with all sensitive information encrypted.

**Key Architectural Decisions & Features:**

*   **UI/UX:** Responsive, offline-first UI with a reorganized navigation sidebar into 6 collapsible groups, quick action UI patterns (hover card, side sheet panel, dropdown actions), and branded elements.
*   **Data Model:** Records track ownership, wallet names, and other metadata.
*   **Encryption:** Full AES-256-GCM encryption at rest for all data and attachments. Includes password change functionality that re-encrypts all data with a new key.
*   **Offline First:** Designed for complete offline functionality, with core logic client-side.
*   **Portability:** Supports fully portable database storage, allowing the application to run from a USB drive.
*   **Vocabulary Management System:** Allows users to define and manage custom tags, categories, owners, wallet names, seed names, and wallet software, with auto-syncing of new vocabulary entries.
*   **Duplicate Detection & Merge System:** Intelligently merges new metadata with existing records, prioritizing manual input and ensuring data integrity.
*   **Address Importer (Bulk Import):** Generates addresses from xpub/zpub keys, supports multisig vault metadata, and includes privacy warnings.
*   **Wallet Data Sync System:** Modular system for importing labels and transaction history from various wallet software, with intelligent duplicate detection and address verification. Includes a private key scanner to prevent importing sensitive data.
*   **BIP-329 Label Import:** Dedicated streamlined importer for BIP-329 standard wallet label exports (.jsonl files):
    *   **3-Step Wizard:** Upload → Preview → Import flow with progress tracking
    *   **Type Support:** Handles addr, tx, input, output records (xpub/pubkey skipped)
    *   **Origin Preservation:** Captures BIP-329 origin field in notes for all record types
    *   **Input/Output Specificity:** Uses full outpoint ref (txid:vout) as inputString to preserve per-outpoint uniqueness and prevent label merging
    *   **Duplicate Detection:** Identifies existing records and shows new vs. update status
    *   **Security:** Rejects files containing private key material
*   **Seed Name Protection:** Limits seed name field length to prevent accidental seed phrase entry.
*   **Address Verification System:** Confirms address ownership with a tiered importance system.
*   **Historical Price Import System:** Imports and stores Bitcoin OHLCV price data from CSV files.
*   **Transaction Sync System (Phase 2):** Fetches blockchain data for tracked addresses from configurable sources, importing confirmed transactions, intelligently matching addresses, and auto-creating "Pending Review" records. Captures outpoint data (prevTxid/prevVout) for inputs to enable exact UTXO matching.
*   **Exact UTXO Tracking (Database v20):** Dual-mode UTXO calculation system:
    *   **Standard Mode:** Uses heuristic address:amount matching (may be approximate for repeated amounts)
    *   **Exact Mode (Beta):** Uses outpoint-based matching (prevTxid:prevVout) for 100% accurate UTXO identification
    *   **Data Coverage Indicators:** Shows 0%/partial/100% outpoint data coverage with re-sync prompts
    *   **Mode Persistence:** User's selected mode saved in settings
    *   **Historical Views:** Both modes integrate with date filter for point-in-time UTXO snapshots
*   **Record Detail Panel:** Comprehensive metadata display with navigation links.
*   **Blockchain Toggle Component:** Filters blockchain-discovered records efficiently using optimized database indexing.
*   **Reports System:** Includes Source of Funds Report (acquisition history, cost basis, valuation) and Hop-Point Detection Report (identifies unclassified addresses with confidence scoring).
*   **Nudgie (Transaction Labeling To-Do):** A workflow for systematically labeling unlabeled transactions, with dashboard and focus views, source filtering, and quick-label buttons.
*   **Transaction Classification Metadata (Database v15):** Tax-neutral fact-recording system for `flowType`, `acquisitionMethod`, `dispositionType`, `costBasisUsd`, and `counterpartyType`.
*   **Bulk Editor:** A powerful batch editing system for updating multiple records at once with a filter builder, action builder, preview panel, and undo capability. Optimized for fast processing of large datasets.
*   **Metadata Conflict Resolution System:** Detects and resolves conflicts when multiple import sources (xpub import, wallet sync, manual entry) provide different values for singular metadata fields:
    *   **Field Classification:** Union fields (tags, categories) accumulate values; Singular fields (seed name, owner, wallet name, wallet software, private key status, label) require resolution
    *   **RecordOrigin System:** Preserves all metadata from each import source with timestamps and origin type
    *   **Conflict Detection:** Identifies records where origins have conflicting singular field values
    *   **Visual Indicators:** Orange dots in MetadataSourcesPanel show which origin values differ from active record
    *   **Standalone Resolution Page:** Full-screen interface with search/filter to view all conflicts, select preferred values, or enter custom values
    *   **RecordDetailPanel Badge:** Clickable conflict indicator navigates to filtered resolution page
*   **Bitcoin Flow Visualizer:** An interactive UTXO provenance tracing tool with Sankey Diagram, Timeline Swimlanes, Line Chart, and Hop-Path Explorer visualizations, prioritizing local data before falling back to blockchain APIs. Owned addresses are highlighted in green for easy identification.
    *   **Hop-Path Explorer:** Interactive tree-based fund flow visualization with recursive node selection, multi-hop traversal using link-based adjacency, loading states during exploration, and color-coded ownership indicators (green=owned, orange=unclassified, gray=external). Includes transaction link metadata display and explore-to-drill functionality.
*   **Transaction Search Enhancement:** Records page search now includes blockchain transactions, showing all participating addresses for a given txid.
*   **Origin Tracking System:** Comprehensive UTXO lineage tracking with:
    *   **utxoLineage table:** Tracks UTXO flow relationships (spent → created) with confidence scoring
    *   **custodySegment table:** Groups lineage chains into ownership periods with acquisition metadata
    *   **Lineage Engine:** Builds lineage from TransactionParticipants with intelligent change detection
    *   **Continuity Proof component:** Visualizes complete ownership timeline with custody duration
    *   **Continuity Certificate Report:** Filtered export of custody segments with selective disclosure
    *   **Evidence Bundle Export:** Privacy-preserving export with toggles for addresses, txids, and lineage chains
*   **Timestamp Standards:** originDate stored as Unix seconds (blockTime), updatedAt as Unix milliseconds (Date.now())
*   **Evidence/Document Storage System (Database v18):** General-purpose encrypted document storage for proof-of-ownership and historical record keeping beyond Bitcoin transactions:
    *   **Evidence Table:** Stores document metadata with fields: title, documentType (email/screenshot/receipt/contract/chat_log), originalDate, notes, tags, partiesInvolved, source, importance (low/medium/high)
    *   **EvidenceAttachments Table:** Encrypted file storage linked to evidence entries, supporting multiple attachments per evidence item
    *   **Full Encryption:** All evidence metadata and attachments encrypted at rest using AES-256-GCM
    *   **Evidence UI:** List view with search/filter by type/importance/date/tags, add/edit forms, file upload with drag-and-drop, detail view with file download
    *   **Sidebar Integration:** Added under "Documents" navigation group

## External Dependencies

### Third-Party Services

*   **Local File System:** Used for storing encrypted attachments.
*   **Google Fonts CDN:** For the Inter font family.

### Bitcoin Libraries

*   **bitcoinjs-lib:** Bitcoin address validation and network detection.
*   **bip32:** HD wallet key derivation.
*   **bip39:** Mnemonic seed phrase handling.

### Security Libraries

*   **Offline Encryption:** AES-256-GCM encryption with PBKDF2 key derivation, running 100% locally in your browser.

### Desktop Packaging

*   **Electron:** Core framework for the desktop application, with security hardening (CSP, context isolation, node integration disabled, remote module blocked, navigation blocking).
*   **electron-builder:** For packaging and distribution.

### UI Dependencies

*   **Radix UI:** Unstyled, accessible component primitives.
*   **Lucide React & React Icons:** Icon libraries.
*   **cmdk:** Command palette component.
*   **class-variance-authority & clsx:** Utilities for dynamic className composition.