# KYBTC - Bitcoin Metadata Manager

## Overview

KYBTC is a secure, offline-first encrypted desktop application designed for managing cryptocurrency metadata. It enables users to organize information about Bitcoin addresses and transactions, attach encrypted files, and manage custom vocabularies (tags, categories). The project prioritizes data privacy through **full encryption at rest**, password-protected access, and complete offline functionality, offering a robust solution for personal crypto data management.

## User Preferences

Preferred communication style: Simple, everyday language.

## Project Phases

### Phase 1 (Current): Metadata Collection
- Manual entry of addresses/transactions with metadata
- Wallet import from various software (Trezor, Sparrow, Mycelium, etc.)
- xPub derivation for bulk address import
- Focus on addresses, transaction IDs, and labels (not amounts/times)

### Phase 2 (Future): Blockchain Data Import
- Import verified transaction data from user's Bitcoin node
- Transaction amounts, times, fees, confirmations
- UTXO tracking and balance calculation

### Phase 3 (Future): Provenance & Reporting
- Flow-of-funds tracking across addresses
- Entity relationship mapping
- Tax and compliance reporting

## System Architecture

### Data Model - Ownership Fields

Records use two fields to track ownership:
- **owner**: Who owns/controls the address (e.g., "Personal", "Spouse", "Acme Corp", "Unknown")
- **walletName**: Specific wallet purpose within an owner (e.g., "College Fund", "Trading", "KYC")

This allows tracking multiple wallets per owner while maintaining clear ownership hierarchy.

### Security Architecture

KYBTC implements robust security via **password-based AES-256-GCM encryption** for all data and attachments. User passwords derive encryption keys using PBKDF2 (100,000 iterations), with keys held only in memory. An automatic logout clears all encryption state, and a data migration process encrypts existing plaintext records upon initial login.

### Frontend Architecture

Built with **React 18, TypeScript, and Vite**, the frontend offers an offline-first, responsive design using `shadcn/ui` and Tailwind CSS. State management leverages TanStack Query for server state and Dexie.js for IndexedDB interactions. It includes **Electron support** for desktop deployment and bitcoinjs-lib for Bitcoin address validation. The UI features a responsive three-panel layout optimized for desktop and mobile, with all core functionality designed to operate without internet access.

### Backend Architecture

The backend utilizes **Express.js with TypeScript**, primarily handling file attachments by storing them in a local `data/attachments/` directory. This minimal backend approach ensures business logic remains client-side, supporting offline capabilities. Development is streamlined with Vite integration for Hot Module Replacement (HMR).

### Electron Desktop App

The Electron framework packages KYBTC as a cross-platform desktop application. It uses OS-specific user data directories for storage and manages file operations (save, read, delete, list) via secure IPC communication, facilitating local, encrypted attachment storage.

### Data Storage Solutions

KYBTC uses **Dexie.js (IndexedDB)** for structured local data, including records, attachment metadata, tags, categories, and settings. All sensitive records are encrypted with AES-256-GCM. The data model supports various record types and includes `RecordOrigin` entries to track metadata sources, facilitating intelligent duplicate detection and merging.

### Duplicate Detection & Merge System

This system ensures "one record per unique `inputString`" by detecting duplicates and intelligently merging new metadata with existing records. It prioritizes existing manual data over new data (e.g., xpub-derived) and unions tags/categories. The `RecordOrigin` table tracks the source of each piece of metadata.

### Wallet Import System

A modular wallet import system (`client/src/lib/wallet-import/`) supports importing transaction history from various wallets like Trezor Suite, Sparrow, and Mycelium (CSV and JSON exports). Features:
- Auto-detection of file format
- Extracts addresses, transaction IDs, and labels only (Phase 1 focus)
- Input addresses get owner/walletName from import settings
- Output addresses default to owner="Unknown" (for later identification)
- Intelligent duplicate detection with merging capabilities

### Historical Price Import System

The price import feature (`client/src/lib/price-parser.ts`, `client/src/pages/PriceImport.tsx`) allows importing historical Bitcoin price data for future reporting. Features:
- Supports multiple data sources: CryptoDataDownload, CoinGecko, Investing.com, Bitget
- Auto-detection of CSV format with intelligent parsing
- OHLCV data storage (Open, High, Low, Close, Volume)
- Upsert logic: updates existing dates, adds new ones
- Stored in IndexedDB `priceData` table with compound index on [date+currency+asset]
- Data is NOT encrypted (public market data, not sensitive)

## External Dependencies

### Third-Party Services

*   **Local File System:** Used for storing encrypted attachments, replacing cloud storage dependencies.
*   **Google Fonts CDN:** For optimized typography, specifically the Inter font family.

### Bitcoin Libraries

*   **bitcoinjs-lib:** Essential for Bitcoin address validation and network detection.
*   **bip32:** Used for HD wallet key derivation, enabling bulk address generation.
*   **bip39:** Facilitates mnemonic seed phrase handling.

### Security Libraries

*   **Web Crypto API:** Native browser API used for AES-256-GCM encryption and PBKDF2 key derivation.

### Desktop Packaging

*   **Electron:** The core framework for building the cross-platform desktop application.
*   **electron-builder:** Used for packaging and distributing the Electron application across different operating systems.

### Development Tools

*   **Replit Vite Plugins:** Enhances the development experience with features like a runtime error modal and code mapping.

### UI Dependencies

*   **Radix UI:** Provides unstyled, accessible component primitives.
*   **Lucide React & React Icons:** Icon libraries for a consistent visual language.
*   **cmdk:** A command palette component for search and command functionality.
*   **class-variance-authority & clsx:** Utilities for dynamic className composition and variant-based styling.