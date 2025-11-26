# KYBTC - Bitcoin Metadata Manager

## Overview

KYBTC is a secure, offline-first Progressive Web App for managing cryptocurrency metadata. It allows users to record and organize information about Bitcoin addresses and transactions, attach files, and manage custom vocabularies (tags, categories). The application emphasizes data privacy with local-first storage, optional encrypted backups, and full functionality without internet connectivity.

**Key Features:**
- Record management for Bitcoin addresses, transaction IDs, and other cryptocurrencies
- File attachments with camera capture support
- Custom tagging and categorization system
- QR code scanning for quick data entry
- Bulk address derivation from extended public keys (xpub/ypub/zpub)
- Export/import with optional encryption
- Responsive dashboard interface for desktop and mobile

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture

**Framework & Build System:**
- React 18 with TypeScript for type-safe component development
- Vite as the build tool and development server
- Wouter for lightweight client-side routing
- Progressive Web App (PWA) capabilities via manifest.json

**UI Component Library:**
- shadcn/ui component system built on Radix UI primitives
- Tailwind CSS for utility-first styling with custom design tokens
- Custom theme system supporting light/dark modes with localStorage persistence
- Design follows Material Design and crypto dashboard patterns (inspired by Coinbase, Ledger Live)

**State Management:**
- TanStack Query (React Query) for server state and caching
- Dexie.js with dexie-react-hooks for reactive IndexedDB queries
- Local component state via React hooks

**Data Validation:**
- bitcoinjs-lib for Bitcoin address and transaction validation
- Custom validation logic to detect address types (P2PKH, P2WPKH, P2SH, P2WSH, P2TR)
- Zod schemas for form validation (via drizzle-zod integration)

**Key Architectural Decisions:**
- **Offline-First Design:** All core functionality works without internet. IndexedDB provides persistent local storage for records, tags, categories, and attachment metadata.
- **Responsive Layout:** Dashboard uses a three-panel layout (sidebar navigation + main content + contextual detail panel) that collapses appropriately on mobile devices.
- **Component Composition:** Atomic design with reusable UI primitives (buttons, cards, badges) composed into domain-specific components (RecordCard, RecordTable, RecordDetailPanel).

### Backend Architecture

**Server Framework:**
- Express.js with TypeScript for API endpoints
- Separate dev and production entry points (index-dev.ts, index-prod.ts)
- Development mode integrates Vite middleware for HMR

**API Structure:**
- RESTful endpoints under `/api` prefix
- Attachment upload/download routes (`/api/attachments/*`)
- Request/response logging middleware with timestamps
- JSON body parsing with raw body preservation for specific endpoints

**Key Architectural Decisions:**
- **Minimal Backend:** Server primarily handles file uploads/downloads; business logic resides in the client for offline capability.
- **Development Experience:** Vite integration in dev mode provides fast refresh and immediate error feedback via custom error overlay plugin.

### Data Storage Solutions

**Client-Side Database:**
- Dexie.js wrapper around IndexedDB for structured local data
- Schema includes tables for: records, attachments (metadata only), tags, categories, settings
- Indexes on frequently queried fields (record type, tags, categories, updatedAt timestamp)
- Full-text search capabilities via custom filtering logic

**Data Model:**
```typescript
Record: {
  id, type (address|transaction|other), inputString, label, notes,
  amount, date, tags[], categories[],
  seedName, walletSoftware, privateKeyStatus, counterparty, source,
  createdAt, updatedAt
}

Attachment: {
  id, recordId, filename, mimeType, size, 
  objectStoragePath, createdAt
}

Tag: { id, name, color, createdAt }
Category: { id, name, createdAt }
Settings: { id, fieldVisibility, preferences }
```

**Key Architectural Decisions:**
- **Separation of Concerns:** Attachment file data stored in object storage, metadata in IndexedDB. This keeps the local database lightweight while maintaining queryability.
- **Timestamps:** All entities track creation/update times for audit trails and sorting.
- **Normalized Relationships:** Tags and categories stored as string arrays in records rather than relational foreign keys for simpler offline querying.

### External Dependencies

**Third-Party Services:**
- **Replit Object Storage (@replit/object-storage):** Cloud storage for file attachments. Configured via `DEFAULT_OBJECT_STORAGE_BUCKET_ID` environment variable.
- **Neon PostgreSQL (@neondatabase/serverless):** Configured in drizzle.config.ts but appears to be provisioned for future use. Currently, the app uses client-side IndexedDB exclusively.
- **Google Fonts CDN:** Inter font family loaded via preconnect for optimized typography.

**Bitcoin Libraries:**
- **bitcoinjs-lib:** Bitcoin address validation and network detection (mainnet/testnet).
- **bip32:** HD wallet key derivation for bulk address generation.
- **bip39:** Mnemonic seed phrase handling (likely for future import/export features).

**Development Tools:**
- **Replit Vite Plugins:** Runtime error modal, cartographer (code mapping), and dev banner for enhanced development experience.
- **Drizzle Kit:** Database schema management and migrations (configured for PostgreSQL but not actively used).

**UI Dependencies:**
- **Radix UI:** Unstyled, accessible component primitives (dialogs, dropdowns, tooltips, etc.).
- **Lucide React & React Icons:** Icon libraries for consistent visual language.
- **cmdk:** Command palette component for future search/command functionality.
- **class-variance-authority & clsx:** Dynamic className composition for variant-based styling.

**Key Architectural Decisions:**
- **Replit Object Storage Choice:** Chose Replit's managed object storage for seamless deployment in the Replit environment. Provides simple file upload/download API without managing S3 buckets or credentials.
- **Hybrid Database Strategy:** Drizzle ORM configured for PostgreSQL suggests future migration path for multi-user or sync features, while maintaining offline-first IndexedDB for current use case.
- **Bitcoin Library Selection:** bitcoinjs-lib chosen as the de facto standard library with comprehensive Bitcoin protocol support and active maintenance.