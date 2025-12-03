# KYUTXO - Bitcoin Metadata Manager

## Overview

KYUTXO is a secure, offline-first encrypted desktop application designed for managing cryptocurrency metadata. It allows users to organize information about Bitcoin addresses and transactions, attach encrypted files, and manage custom vocabularies (tags, categories). The project prioritizes data privacy through **full encryption at rest**, password-protected access, and complete offline functionality, offering a robust solution for personal crypto data management.

The project is currently in Phase 2, focusing on blockchain data import and transaction synchronization. Future ambitions include advanced provenance tracking, entity relationship mapping, and tax/compliance reporting.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

KYUTXO employs a robust, security-focused architecture. All data and attachments are secured with **password-based AES-256-GCM encryption**, deriving keys using PBKDF2.

The frontend is built with **React 18, TypeScript, and Vite**, utilizing `shadcn/ui` and Tailwind CSS for a responsive, offline-first UI. State management is handled by TanStack Query and Dexie.js for IndexedDB interactions. **Electron** packages the application for cross-platform desktop deployment.

The backend uses **Express.js with TypeScript** primarily for local file attachment management, ensuring core business logic remains client-side to support offline capabilities.

Data is stored locally using **Dexie.js (IndexedDB)** for structured data (records, attachments, vocabularies, settings), with all sensitive information encrypted. A comprehensive **Vocabulary Management System** allows users to define and manage tags, categories, owners, wallet names, seed names, and wallet software.

Key features include:
- **Data Model**: Records track ownership via `owner` and `walletName` fields.
- **Duplicate Detection & Merge System**: Ensures data integrity by merging new metadata with existing records, prioritizing manual data.
- **Vocabulary Auto-Sync**: When records are created or updated with owner, walletName, seedName, or walletSoftware values, those values are automatically added to their respective vocabulary tables for future dropdown selections.
- **Address Importer (Bulk Import)**: Generates addresses from xpub/zpub keys with dropdown selectors for Owner, Wallet Name, Seed Name, and Wallet Software using vocabulary hooks. Supports optional derivation template storage with "Save template for future derivations" checkbox and privacy warning (xpubs reveal wallet structure). Includes multisig vault metadata fields (vault name, M-of-N quorum, notes).
- **Wallet Data Sync System**: Modular system for importing labels and transaction history from various wallet software (e.g., Trezor, Sparrow's BIP-329 exports) with intelligent duplicate detection and address verification. Includes dropdown selectors for Owner, Wallet Name, and Wallet Software with auto-detection override capability. Label prefix supports [date], [wallet], and [id] tokens. Private key scanner actively rejects files containing xprv, wif, keystore, or other sensitive data. Supports multisig vault metadata fields matching Address Importer.
- **Seed Name Protection**: Seed name fields are limited to 15 characters (centralized in `use-seed-names.ts` hook with `SEED_NAME_MAX_LENGTH`) to prevent accidental pasting of actual seed phrases (which are 12-24 words, far exceeding this limit).
- **Address Verification System**: Explicitly confirms address ownership, with a tiered `addressImportance` system to prevent downgrading verified addresses.
- **Historical Price Import System**: Allows importing and storing Bitcoin OHLCV price data from CSV files for future reporting.
- **Transaction Sync System (Phase 2)**: Fetches blockchain data for tracked addresses from configurable sources (public APIs, custom Electrs, Tor) with privacy indicators. It only imports transactions with 5+ confirmations, intelligently matches addresses, and auto-creates "Pending Review" records for discovered addresses. It includes a depth-limited sync for exploring address relationships.
- **Reports System**: Self-contained reporting features in `/client/src/components/reports/`:
  - **Source of Funds Report**: Shows acquisition history, cost basis from historical price data, current valuation, and unrealized gain/loss. Internal transfers (same owner) are flagged as non-taxable for capital gains purposes.
  - **Hop-Point Detection Report**: Identifies unclassified addresses that connect known addresses, with confidence scoring to suggest classification (likely own wallet vs. counterparty).
- **Provenance System (Phase 3)**: A future feature for tracing the flow of funds between addresses using BFS-based pathfinding, an address importance hierarchy, and an interactive Address Explorer.

## External Dependencies

### Third-Party Services

*   **Local File System:** For storing encrypted attachments.
*   **Google Fonts CDN:** For the Inter font family.

### Bitcoin Libraries

*   **bitcoinjs-lib:** For Bitcoin address validation and network detection.
*   **bip32:** For HD wallet key derivation.
*   **bip39:** For mnemonic seed phrase handling.

### Security Libraries

*   **Web Crypto API:** For AES-256-GCM encryption and PBKDF2 key derivation.

### Desktop Packaging

*   **Electron:** Core framework for the desktop application.
*   **electron-builder:** For packaging and distribution.

#### Electron Security Hardening

The Electron app implements comprehensive security measures:
- **Content Security Policy (CSP)**: Restrictive headers set via session
- **Context Isolation**: Enabled with sandboxed renderer process
- **Node Integration Disabled**: Prevents direct Node.js access from renderer
- **Remote Module Blocked**: Prevents remote content execution
- **Navigation Blocking**: External URLs blocked, user redirected to browser

#### Portable Mode

KYUTXO supports portable USB drive deployment:
- Create an empty file named `portable` in the app directory
- Data will be stored in `KYUTXO_Data/` folder next to the executable
- Without the portable marker, data is stored in standard system directories

#### Building for Distribution

Run the helper scripts to build:
```bash
./scripts/electron-dev.sh   # Development mode with hot reload
./scripts/electron-build.sh # Production build
```

Note: For production Windows/macOS builds, convert `icon.png` to `.ico`/`.icns` formats.

### UI Dependencies

*   **Radix UI:** Provides unstyled, accessible component primitives.
*   **Lucide React & React Icons:** Icon libraries.
*   **cmdk:** Command palette component.
*   **class-variance-authority & clsx:** Utilities for dynamic className composition.