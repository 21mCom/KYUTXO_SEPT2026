import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import JSZip from 'jszip';
import {
  STABLE_BACKUP_FIXTURE_PATH,
  STABLE_BACKUP_PASSWORD,
  auditStableBackupFixturePrivacy,
} from './stable-backup-fixture.mjs';

async function fixtureZip() {
  return JSZip.loadAsync(fs.readFileSync(STABLE_BACKUP_FIXTURE_PATH));
}

async function fixtureKey(manifest) {
  const baseKey = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(STABLE_BACKUP_PASSWORD),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return webcrypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: Buffer.from(manifest.salt, 'base64'),
      iterations: 100_000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function decrypt(envelope, key) {
  const bytes = Buffer.from(envelope, 'base64');
  const plaintext = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(0, 12) },
    key,
    bytes.subarray(12),
  );
  return new TextDecoder().decode(plaintext);
}

async function encrypt(plaintext, key) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  ));
  return Buffer.concat([iv, ciphertext]).toString('base64');
}

async function mutatedRecords(mutator) {
  const zip = await fixtureZip();
  const manifest = JSON.parse(await zip.file('backup.json').async('text'));
  const key = await fixtureKey(manifest);
  const entry = zip.file('tables/records.ndjson');
  const lines = (await entry.async('text')).split(/\r?\n/).filter(Boolean);
  const rows = JSON.parse(await decrypt(lines[0], key));
  mutator(rows);
  zip.file(
    'tables/records.ndjson',
    `${await encrypt(JSON.stringify(rows), key)}\n`,
    { createFolders: false },
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('accepts the pinned fixture only after decrypting every allowlisted table', async () => {
  const result = await auditStableBackupFixturePrivacy(
    fs.readFileSync(STABLE_BACKUP_FIXTURE_PATH),
  );
  assert.deepEqual(result, { archiveEntries: 9, portableTables: 23 });
});

test('rejects extra archive and attachment entries', async () => {
  const zip = await fixtureZip();
  zip.file('attachments/leaked.txt', 'not synthetic');
  await assert.rejects(
    auditStableBackupFixturePrivacy(await zip.generateAsync({ type: 'nodebuffer' })),
    /Archive entry list is outside the explicit synthetic allowlist/,
  );
});

test('rejects unexpected plaintext manifest text', async () => {
  const zip = await fixtureZip();
  const manifest = JSON.parse(await zip.file('backup.json').async('text'));
  manifest.description = 'unexpected non-synthetic text';
  zip.file('backup.json', JSON.stringify(manifest));
  await assert.rejects(
    auditStableBackupFixturePrivacy(await zip.generateAsync({ type: 'nodebuffer' })),
    /Manifest field list is outside the explicit synthetic allowlist/,
  );
});

test('rejects unexpected decrypted rows and non-synthetic text', async () => {
  const mutated = await mutatedRecords((rows) => {
    rows.push({ type: 'other', inputString: 'unexpected real-looking row' });
  });
  await assert.rejects(
    auditStableBackupFixturePrivacy(mutated),
    /Streamed table records is outside the explicit synthetic allowlist/,
  );
});

test('rejects private-key material before ordinary allowlist comparison', async () => {
  const mutated = await mutatedRecords((rows) => {
    rows[0].notes = '5HueCGU8rMjxEXxiPuD5BDuRaKCV2yE4BTHBQa6sD4Yt93YkPZJ';
  });
  await assert.rejects(
    auditStableBackupFixturePrivacy(mutated),
    /contains private-key or seed-phrase material/,
  );
});