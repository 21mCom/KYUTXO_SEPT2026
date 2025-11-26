import Dexie, { type Table } from 'dexie';

export interface Record {
  id?: number;
  type: 'address' | 'transaction';
  inputString: string;
  label: string;
  notes?: string;
  amount?: number;
  date?: string;
  tags: string[];
  categories: string[];
  seedName?: string;
  walletSoftware?: string;
  privateKeyStatus?: string;
  counterparty?: string;
  source?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Attachment {
  id?: number;
  recordId: number;
  filename: string;
  mimeType: string;
  size: number;
  objectStoragePath: string;
  createdAt: number;
}

export interface Tag {
  id?: number;
  name: string;
  color?: string;
  createdAt: number;
}

export interface Category {
  id?: number;
  name: string;
  createdAt: number;
}

export interface Settings {
  id: string;
  fieldVisibility: {
    seedName: boolean;
    walletSoftware: boolean;
    privateKeyStatus: boolean;
    counterparty: boolean;
    source: boolean;
  };
  tableColumns: {
    tags: boolean;
    categories: boolean;
    walletSoftware: boolean;
    seedName: boolean;
    privateKeyStatus: boolean;
    hasAttachments: boolean;
  };
  theme: 'light' | 'dark';
  defaultView: 'table' | 'grid';
}

export class KYBTCDatabase extends Dexie {
  records!: Table<Record>;
  attachments!: Table<Attachment>;
  tags!: Table<Tag>;
  categories!: Table<Category>;
  settings!: Table<Settings>;

  constructor() {
    super('KYBTCDatabase');
    
    this.version(1).stores({
      records: '++id, type, inputString, label, *tags, *categories, createdAt, updatedAt',
      attachments: '++id, recordId, createdAt',
      tags: '++id, name, createdAt',
      categories: '++id, name, createdAt',
      settings: 'id'
    });
  }
}

export const db = new KYBTCDatabase();

// Initialize default settings
db.on('ready', async () => {
  const settings = await db.settings.get('default');
  if (!settings) {
    await db.settings.add({
      id: 'default',
      fieldVisibility: {
        seedName: true,
        walletSoftware: true,
        privateKeyStatus: false,
        counterparty: true,
        source: true,
      },
      tableColumns: {
        tags: true,
        categories: false,
        walletSoftware: false,
        seedName: false,
        privateKeyStatus: false,
        hasAttachments: true,
      },
      theme: 'light',
      defaultView: 'table',
    });
  } else if (!settings.tableColumns) {
    // Migration: add tableColumns if missing
    await db.settings.update('default', {
      tableColumns: {
        tags: true,
        categories: false,
        walletSoftware: false,
        seedName: false,
        privateKeyStatus: false,
        hasAttachments: true,
      },
    });
  }
});
