# KYBTC - Bitcoin Metadata Manager

## Overview

KYBTC is a secure, offline-first encrypted desktop application for managing cryptocurrency metadata. It allows users to record and organize information about Bitcoin addresses and transactions, attach files, and manage custom vocabularies (tags, categories). The application emphasizes data privacy with **full encryption at rest**, password-protected access, and complete offline functionality.

**Key Features:**
- Record management for Bitcoin addresses, transaction IDs, and other cryptocurrencies
- **AES-256-GCM encryption for all stored data** (database records and file attachments)
- **Password-protected vault** with PBKDF2 key derivation (100,000 iterations)
- File attachments with camera capture support and client-side encryption
- Custom tagging and categorization system
- QR code scanning for quick data entry
- Bulk address derivation from extended public keys (xpub/ypub/zpub)
- Export/import with encryption
- Responsive dashboard interface for desktop and mobile
- **Electron desktop app packaging** for fully local operation

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Security Architecture

**Password-Based Encryption:**
- User password/passphrase required to access the vault
- PBKDF2 key derivation with 100,000 iterations and random salt
- AES-256-GCM encryption for all sensitive data
- Encryption key held only in memory, never persisted
- Automatic logout clears all encryption state

**Encryption Implementation:**
- `client/src/lib/crypto.ts`: Core crypto utilities (encrypt/decrypt, key derivation, binary encryption)
- `client/src/lib/vault.ts`: Vault settings storage (salt, password hash, migration status)
- `client/src/lib/dbEncryption.ts`: Database record/attachment/tag/category encryption
- `client/src/lib/encryptionFacade.ts`: Centralized encryption key management
- `client/src/contexts/AuthContext.tsx`: Authentication flow and session management
- `client/src/components/LoginScreen.tsx`: Login/setup UI

**Data Migration:**
- Automatic migration encrypts existing plaintext records on first login
- Migration runs in background after successful authentication
- `migrationComplete` flag prevents re-migration

### Frontend Architecture

**Framework & Build System:**
- React 18 with TypeScript for type-safe component development
- Vite as the build tool and development server
- Wouter for lightweight client-side routing
- Progressive Web App (PWA) capabilities via manifest.json
- **Electron support** for desktop app deployment

**UI Component Library:**
- shadcn/ui component system built on Radix UI primitives
- Tailwind CSS for utility-first styling with custom design tokens
- Custom theme system supporting light/dark modes with localStorage persistence
- Design follows Material Design and crypto dashboard patterns

**State Management:**
- TanStack Query (React Query) for server state and caching
- Dexie.js with dexie-react-hooks for reactive IndexedDB queries
- Local component state via React hooks
- EncryptionFacade for encryption key state

**Data Validation:**
- bitcoinjs-lib for Bitcoin address and transaction validation
- Custom validation logic to detect address types (P2PKH, P2WPKH, P2SH, P2WSH, P2TR)
- Zod schemas for form validation (via drizzle-zod integration)

**Key Architectural Decisions:**
- **Offline-First Design:** All core functionality works without internet. IndexedDB provides persistent local storage for records, tags, categories, and attachment metadata.
- **Client-Side Encryption:** All encryption happens in the browser/client; server never sees plaintext data or encryption keys.
- **Responsive Layout:** Dashboard uses a three-panel layout (sidebar navigation + main content + contextual detail panel) that collapses appropriately on mobile devices.
- **Dual-Mode Operation:** Attachments work via Express API in web mode or Electron IPC in desktop mode.

### Backend Architecture

**Server Framework:**
- Express.js with TypeScript for API endpoints
- Separate dev and production entry points (index-dev.ts, index-prod.ts)
- Development mode integrates Vite middleware for HMR

**API Structure:**
- RESTful endpoints under `/api` prefix
- Attachment upload/download routes (`/api/attachments/*`)
- Local file system storage for attachments (replaces cloud storage)
- Request/response logging middleware with timestamps
- JSON body parsing with raw body preservation for specific endpoints

**Key Architectural Decisions:**
- **Local File Storage:** Attachments stored in local `data/attachments/` directory using sanitized address/txid as folder names.
- **Minimal Backend:** Server primarily handles file uploads/downloads; business logic resides in the client for offline capability.
- **Development Experience:** Vite integration in dev mode provides fast refresh and immediate error feedback.

### Electron Desktop App

**Electron Architecture:**
- `electron/main.js`: Main process with file system IPC handlers
- `electron/preload.js`: Secure context bridge for IPC communication
- `client/src/lib/electron.ts`: Electron detection and API types
- `electron-builder.json`: Packaging configuration for Windows, Mac, Linux

**App Data Storage:**
- Uses OS-specific user data directory (`app.getPath('userData')`)
- Creates `data/attachments/` subdirectory for encrypted file storage
- Files organized by sanitized record identifier (address/txid)

**IPC Operations:**
- `save-attachment`: Save encrypted file to local storage
- `read-attachment`: Read encrypted file from local storage
- `delete-attachment`: Remove file from local storage
- `list-attachments`: List files for a record

### Data Storage Solutions

**Client-Side Database:**
- Dexie.js wrapper around IndexedDB for structured local data
- Schema includes tables for: records, attachments (metadata only), tags, categories, settings
- All records encrypted with AES-256-GCM; `encryptedPayload` field contains ciphertext
- `isEncrypted` flag indicates encryption status for migration purposes
- Indexes on non-sensitive fields for querying (type, timestamps)

**Data Model:**
```typescript
Record: {
  id, type (address|transaction|other), inputString, label, notes,
  amount, date, tags[], categories[],
  seedName, walletSoftware, privateKeyStatus, counterparty, source,
  createdAt, updatedAt,
  encryptedPayload?, isEncrypted?
}

Attachment: {
  id, recordId, filename, mimeType, size, 
  objectStoragePath, createdAt,
  encryptedPayload?, isEncrypted?
}

Tag: { id, name, color, createdAt, encryptedPayload?, isEncrypted? }
Category: { id, name, createdAt, encryptedPayload?, isEncrypted? }
Settings: { id, fieldVisibility, tableColumns, theme, defaultView }
```

**Key Architectural Decisions:**
- **Separation of Concerns:** Attachment file data stored in local filesystem, metadata in IndexedDB.
- **Staged Encryption Rollout:** EncryptionFacade pattern allows writes to use encryption while maintaining read compatibility during migration.
- **Timestamps:** All entities track creation/update times for audit trails and sorting.
- **Normalized Relationships:** Tags and categories stored as string arrays in records rather than relational foreign keys for simpler offline querying.

### External Dependencies

**Third-Party Services:**
- **Local File System:** Replaces cloud storage; all attachments stored locally with encryption.
- **Google Fonts CDN:** Inter font family loaded via preconnect for optimized typography.

**Bitcoin Libraries:**
- **bitcoinjs-lib:** Bitcoin address validation and network detection (mainnet/testnet).
- **bip32:** HD wallet key derivation for bulk address generation.
- **bip39:** Mnemonic seed phrase handling.

**Security Libraries:**
- **Web Crypto API:** Native browser crypto for AES-256-GCM and PBKDF2.

**Desktop Packaging:**
- **Electron:** Desktop application framework.
- **electron-builder:** Cross-platform packaging and distribution.

**Development Tools:**
- **Replit Vite Plugins:** Runtime error modal, cartographer (code mapping), and dev banner for enhanced development experience.
- **Drizzle Kit:** Database schema management (configured but not actively used).

**UI Dependencies:**
- **Radix UI:** Unstyled, accessible component primitives (dialogs, dropdowns, tooltips, etc.).
- **Lucide React & React Icons:** Icon libraries for consistent visual language.
- **cmdk:** Command palette component for search/command functionality.
- **class-variance-authority & clsx:** Dynamic className composition for variant-based styling.

**Key Architectural Decisions:**
- **Local-First Priority:** Removed dependency on external cloud providers; all data stays on user's device.
- **Client-Side Encryption:** Server never sees encryption keys; all sensitive data encrypted in browser before storage.
- **Cross-Platform Desktop:** Electron enables packaging for Windows, macOS, and Linux distributions.
- **Bitcoin Library Selection:** bitcoinjs-lib chosen as the de facto standard library with comprehensive Bitcoin protocol support.

### Duplicate Detection & Merge System

**Core Principle:** One record per unique `inputString`, with `RecordOrigin` entries tracking different metadata sources.

**Components:**
- `findRecordByInputString`: Searches for existing records by address/txid/identifier
- `createRecordOrigin`: Creates origin entries to track metadata sources
- `mergeRecordWithOrigins`: Combines record data with origin metadata

**Manual Entry Flow (RecordFormDialog):**
1. User enters inputString in form
2. On field blur, `onCheckDuplicate` callback fires
3. If duplicate found, form auto-populates with existing record data
4. Alert displays warning about existing record
5. Save converts to update operation instead of create

**Bulk Import Flow (BulkImport):**
1. For each derived address, check if it exists via `findRecordByInputString`
2. If exists: merge tags/categories (union), preserve existing metadata values, create RecordOrigin entry
3. If new: create record with xpub-derived metadata
4. Display summary: N new, M merged, K failed

**Merge Priority:**
- Existing (manual) data takes priority over new (xpub-derived) data
- Tags and categories are unioned (combined)
- Empty fields can be filled by new data

**RecordOrigin Table:**
```typescript
RecordOrigin: {
  id, recordId, originType ('manual' | 'xpub-derived'),
  label, notes, tags[], categories[],
  seedName, walletSoftware, privateKeyStatus, counterparty,
  xpub, derivationPath, chainType,
  createdAt, encryptedPayload?, isEncrypted?
}
```

## Recent Changes

**November 2024 - Value Updater Feature:**
- Created new "Value Updater" page to replace "Tags & Categories" page
- Supports bulk renaming of values across all records for: Tags, Categories, Wallet Software, Seed Name, Counterparty
- When a value is renamed, ALL records using that value are automatically updated
- For Tags/Categories, the master list entry is also updated alongside record values
- Shows usage count for each unique value across records
- Supports adding new Tags/Categories and deleting unused entries
- Removes the old "Tags & Categories" page and navigation link

**November 2024 - UI/UX Improvements:**
- Renamed "Bulk Importer" to "Address Importer" in sidebar navigation
- Reordered sidebar: Records, Address Importer, QR Scanner, Value Updater, Export Data, Settings
- Added QR code generation feature in record detail panel for addresses and transaction IDs
- Clicking the QR icon shows a dialog with the scannable QR code

**November 2024 - Data Management Features:**
- Added "Clear Database" feature in Settings with double confirmation:
  - Requires entering vault password AND typing "DELETE ALL DATA" phrase
  - Permanently wipes all records, tags, categories, attachments, and custom fields
- Added "Restore from Backup" feature in Settings:
  - Upload previously exported ZIP backup files
  - Supports both encrypted and unencrypted backups
  - Two restore modes: "Replace all data" (wipes existing) or "Merge with existing" (skips duplicates)
  - Progress indicator shows restore status

**November 2024 - Dynamic Column Visibility:**
- Added Source field as toggleable column in records table
- Custom fields now appear as toggleable columns in the column selector
- Column selector shows "Custom Fields" section with individual field toggles when custom fields are defined
- Filter dropdowns (Tags, Categories) automatically hide when their corresponding columns are hidden
- Active tag/category filters are automatically cleared when their columns are hidden (prevents hidden filter confusion)
- Source and custom field columns properly handle encrypted values by showing "-" instead of placeholders
- Settings schema extended with `source` in tableColumns and `customFieldColumns: Record<string, boolean>` map

**November 2024 - Duplicate Detection & Record Types:**
- Renamed "Other Coin" to "Other" for simpler record type naming
- Added unique constraint on inputString to prevent duplicates at database level
- Implemented duplicate detection with auto-population in RecordFormDialog
- Added RecordOrigin table to track metadata sources (manual vs xpub-derived)
- Updated BulkImport to detect duplicates and merge metadata instead of creating duplicates
- Import summary now shows created vs merged vs failed counts

**November 2024 - Security & Desktop Transformation:**
- Replaced Replit Object Storage with local file system storage
- Implemented password-based vault authentication
- Added AES-256-GCM encryption for all database records and attachments
- Created client-side file encryption before disk storage
- Added Electron packaging infrastructure for desktop distribution
- Implemented automatic migration to encrypt existing plaintext data
