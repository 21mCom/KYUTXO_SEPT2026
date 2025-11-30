# KYBTC - Bitcoin Metadata Manager

## Overview

KYBTC is a secure, offline-first encrypted desktop application designed for managing cryptocurrency metadata. It allows users to organize information about Bitcoin addresses and transactions, attach encrypted files, and manage custom vocabularies (tags, categories). The project prioritizes data privacy through **full encryption at rest**, password-protected access, and complete offline functionality, offering a robust solution for personal crypto data management.

The project is currently in Phase 2, focusing on blockchain data import and transaction synchronization. Future ambitions include advanced provenance tracking, entity relationship mapping, and tax/compliance reporting.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

KYBTC employs a robust, security-focused architecture. All data and attachments are secured with **password-based AES-256-GCM encryption**, deriving keys using PBKDF2.

The frontend is built with **React 18, TypeScript, and Vite**, utilizing `shadcn/ui` and Tailwind CSS for a responsive, offline-first UI. State management is handled by TanStack Query and Dexie.js for IndexedDB interactions. **Electron** packages the application for cross-platform desktop deployment.

The backend uses **Express.js with TypeScript** primarily for local file attachment management, ensuring core business logic remains client-side to support offline capabilities.

Data is stored locally using **Dexie.js (IndexedDB)** for structured data (records, attachments, vocabularies, settings), with all sensitive information encrypted. A comprehensive **Vocabulary Management System** allows users to define and manage tags, categories, owners, wallet names, seed names, and wallet software.

Key features include:
- **Data Model**: Records track ownership via `owner` and `walletName` fields.
- **Duplicate Detection & Merge System**: Ensures data integrity by merging new metadata with existing records, prioritizing manual data.
- **Wallet Import System**: Modular system for importing transaction history from various wallet software (e.g., Trezor, Sparrow) with intelligent duplicate detection and address verification.
- **Address Verification System**: Explicitly confirms address ownership, with a tiered `addressImportance` system to prevent downgrading verified addresses.
- **Historical Price Import System**: Allows importing and storing Bitcoin OHLCV price data from CSV files for future reporting.
- **Transaction Sync System (Phase 2)**: Fetches blockchain data for tracked addresses from configurable sources (public APIs, custom Electrs, Tor) with privacy indicators. It only imports transactions with 5+ confirmations, intelligently matches addresses, and auto-creates "Pending Review" records for discovered addresses. It includes a depth-limited sync for exploring address relationships.
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

### UI Dependencies

*   **Radix UI:** Provides unstyled, accessible component primitives.
*   **Lucide React & React Icons:** Icon libraries.
*   **cmdk:** Command palette component.
*   **class-variance-authority & clsx:** Utilities for dynamic className composition.