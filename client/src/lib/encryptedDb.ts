// Encrypted Database Layer
// All data is encrypted before being stored in IndexedDB

import Dexie, { type Table } from 'dexie';
import { encrypt, decrypt } from './crypto';
import type { Record, Attachment, Tag, Category, Settings } from './database';

// Encrypted storage format
interface EncryptedEntry {
  id: string; // Composite key
  data: string; // Encrypted JSON
  updatedAt: number;
}

class EncryptedDatabase extends Dexie {
  entries!: Table<EncryptedEntry>;

  constructor() {
    super('kybtc-encrypted');
    
    this.version(1).stores({
      entries: 'id, updatedAt',
    });
  }
}

const encryptedDb = new EncryptedDatabase();

// Key prefixes for different data types
const PREFIXES = {
  RECORD: 'record:',
  ATTACHMENT: 'attachment:',
  TAG: 'tag:',
  CATEGORY: 'category:',
  SETTINGS: 'settings:',
} as const;

// Encrypted data operations
export class EncryptedStore<T> {
  constructor(
    private prefix: string,
    private getKey: () => CryptoKey | null
  ) {}

  private get key(): CryptoKey {
    const k = this.getKey();
    if (!k) throw new Error('Encryption key not available');
    return k;
  }

  private makeId(id: number | string): string {
    return `${this.prefix}${id}`;
  }

  private extractId(compositeId: string): string {
    return compositeId.replace(this.prefix, '');
  }

  async add(item: T & { id?: number | string }): Promise<number | string> {
    const id = item.id ?? Date.now();
    const itemWithId = { ...item, id };
    const encryptedData = await encrypt(JSON.stringify(itemWithId), this.key);
    
    await encryptedDb.entries.put({
      id: this.makeId(id),
      data: encryptedData,
      updatedAt: Date.now(),
    });
    
    return id;
  }

  async put(item: T & { id: number | string }): Promise<void> {
    const encryptedData = await encrypt(JSON.stringify(item), this.key);
    
    await encryptedDb.entries.put({
      id: this.makeId(item.id),
      data: encryptedData,
      updatedAt: Date.now(),
    });
  }

  async get(id: number | string): Promise<T | undefined> {
    const entry = await encryptedDb.entries.get(this.makeId(id));
    if (!entry) return undefined;
    
    try {
      const decrypted = await decrypt(entry.data, this.key);
      return JSON.parse(decrypted);
    } catch (error) {
      console.error('Failed to decrypt entry:', error);
      return undefined;
    }
  }

  async getAll(): Promise<T[]> {
    const entries = await encryptedDb.entries
      .where('id')
      .startsWith(this.prefix)
      .toArray();
    
    const results: T[] = [];
    for (const entry of entries) {
      try {
        const decrypted = await decrypt(entry.data, this.key);
        results.push(JSON.parse(decrypted));
      } catch (error) {
        console.error('Failed to decrypt entry:', error);
      }
    }
    
    return results;
  }

  async update(id: number | string, updates: Partial<T>): Promise<void> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Entry not found: ${id}`);
    
    const updated = { ...existing, ...updates };
    await this.put(updated as T & { id: number | string });
  }

  async delete(id: number | string): Promise<void> {
    await encryptedDb.entries.delete(this.makeId(id));
  }

  async clear(): Promise<void> {
    const entries = await encryptedDb.entries
      .where('id')
      .startsWith(this.prefix)
      .toArray();
    
    const ids = entries.map(e => e.id);
    await encryptedDb.entries.bulkDelete(ids);
  }

  async count(): Promise<number> {
    return encryptedDb.entries
      .where('id')
      .startsWith(this.prefix)
      .count();
  }

  // Query with filter function (loads all and filters in memory)
  async filter(predicate: (item: T) => boolean): Promise<T[]> {
    const all = await this.getAll();
    return all.filter(predicate);
  }

  // Query with where clause (by specific field value)
  async where(field: keyof T, value: any): Promise<T[]> {
    const all = await this.getAll();
    return all.filter(item => item[field] === value);
  }
}

// Create stores for each data type
export function createEncryptedStores(getKey: () => CryptoKey | null) {
  return {
    records: new EncryptedStore<Record>(PREFIXES.RECORD, getKey),
    attachments: new EncryptedStore<Attachment>(PREFIXES.ATTACHMENT, getKey),
    tags: new EncryptedStore<Tag>(PREFIXES.TAG, getKey),
    categories: new EncryptedStore<Category>(PREFIXES.CATEGORY, getKey),
    settings: new EncryptedStore<Settings>(PREFIXES.SETTINGS, getKey),
  };
}

// Export the raw encrypted database for advanced operations
export { encryptedDb };
