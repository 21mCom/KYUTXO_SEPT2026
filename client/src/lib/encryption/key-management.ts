import { clearDecryptCache } from './decrypt-cache';

let _encryptionKey: CryptoKey | null = null;

export function initEncryptionFacade(key: CryptoKey): void {
  clearDecryptCache();
  _encryptionKey = key;
}

export function clearEncryptionFacade(): void {
  _encryptionKey = null;
  clearDecryptCache();
}

export function isEncryptionReady(): boolean {
  return _encryptionKey !== null;
}

export function getEncryptionKey(): CryptoKey | null {
  return _encryptionKey;
}

export function getKey(): CryptoKey {
  if (!_encryptionKey) {
    throw new Error('Encryption not initialized. Please login first.');
  }
  return _encryptionKey;
}
