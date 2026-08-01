// Persisted trust-on-first-use (TOFU) store for Electrum server TLS
// certificates. Self-signed certificates are the norm on personal Electrum
// servers (Electrs, Fulcrum), so strict CA verification alone would lock
// users out; instead the user is shown the certificate fingerprint once,
// explicitly trusts it, and every later connection must present the SAME
// certificate. A changed fingerprint (e.g. a MITM swapping certs) fails the
// connection with a distinct error instead of being silently accepted.
//
// Pure Node module (no `electron` import) so Node-level vitest tests can
// exercise it directly.

const fs = require('fs');
const path = require('path');

const STORE_VERSION = 1;

function certStorePath(dataDir) {
  return path.join(dataDir, 'electrum-trusted-certs.json');
}

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase();
}

function storeKey(host, port) {
  return `${normalizeHost(host)}:${port}`;
}

function emptyStore() {
  return { version: STORE_VERSION, certificates: {} };
}

// Load the trust store from disk. A missing or corrupt file is treated as an
// empty store — never as "trust everything".
function loadTrustStore(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.certificates &&
      typeof parsed.certificates === 'object'
    ) {
      return parsed;
    }
  } catch {
    // Missing/unreadable/corrupt store -> empty.
  }
  return emptyStore();
}

function saveTrustStore(filePath, store) {
  // Write-then-rename so a crash mid-write can't leave a truncated store.
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

// Look up the pinned certificate for a host:port, or null when none exists.
function getPinnedCertificate(filePath, host, port) {
  if (!filePath) return null;
  const store = loadTrustStore(filePath);
  const pinned = store.certificates[storeKey(host, port)];
  return pinned || null;
}

// Persist (or overwrite) a trust decision for a host:port. Overwriting is
// intentional: after a CERT_FINGERPRINT_CHANGED warning the user may verify
// the new fingerprint out-of-band and re-trust. `certInfo` carries the
// fingerprint plus display metadata shown in the trust prompt.
function trustCertificate(filePath, host, port, certInfo) {
  if (!filePath) throw new Error('No certificate trust store configured');
  const fingerprint = String(certInfo?.fingerprint || '').toUpperCase();
  if (!fingerprint) throw new Error('A certificate fingerprint is required');

  const store = loadTrustStore(filePath);
  const entry = {
    fingerprint,
    subject: certInfo.subject ? String(certInfo.subject) : undefined,
    issuer: certInfo.issuer ? String(certInfo.issuer) : undefined,
    validFrom: certInfo.validFrom ? String(certInfo.validFrom) : undefined,
    validTo: certInfo.validTo ? String(certInfo.validTo) : undefined,
    trustedAt: Date.now(),
  };
  store.certificates[storeKey(host, port)] = entry;
  saveTrustStore(filePath, store);
  return entry;
}

// Remove a pinned certificate for a host:port. Returns true when a pin
// existed and was removed, false when there was nothing to revoke. After a
// revoke the next connection to that server goes back through the TOFU
// prompt (or plain CA verification).
function revokeCertificate(filePath, host, port) {
  if (!filePath) throw new Error('No certificate trust store configured');
  const store = loadTrustStore(filePath);
  const key = storeKey(host, port);
  if (!store.certificates[key]) return false;
  delete store.certificates[key];
  saveTrustStore(filePath, store);
  return true;
}

module.exports = {
  certStorePath,
  storeKey,
  loadTrustStore,
  getPinnedCertificate,
  trustCertificate,
  revokeCertificate,
};
