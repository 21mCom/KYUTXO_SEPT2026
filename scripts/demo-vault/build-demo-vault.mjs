#!/usr/bin/env node
// Build the real-data demo showcase vault (Task: demo vault).
//
// Fetches REAL on-chain data from the public mempool.space Esplora API
// (rate-limited, disk-cached, fully resumable), curates a 5k-10k row dataset
// that exercises every major KYUTXO feature, applies fictional persona
// metadata, and writes it out as a standard restorable v3 backup ZIP:
//
//   demo/kyutxo-demo-vault.zip     <- restorable v3 backup (plaintext)
//   demo/demo-entity-list.json     <- importable demo entity-list snapshot
//   demo/coverage-report.json      <- feature coverage matrix result
//
// Curation strategy (all txids/addresses are real; only labels are fiction):
//   1. Seed from bundled entity-list addresses (exchange/mixer/scam/...).
//   2. Harvest their real counterparties; adopt ~30 as "owned" persona
//      addresses (so direct entity contact is guaranteed by construction).
//   3. Fetch full histories of owned addresses; harvest hop-2 "watch"
//      addresses and one page of their histories (multi-hop fund trails and
//      proximity findings at 2-3 hops).
//   4. Gap-fill for specific patterns: dust receipts, reused addresses,
//      spent-from P2PKH (exposed pubkey / quantum), P2SH-P2WSH (vault +
//      lightning-like channel outputs).
//   5. Assemble records / blockchainTransactions / transactionParticipants /
//      addressSyncState / utxoLineage / custodySegments + vocabulary tables
//      and zip them in v3 layout (manifest first, records before dependents).
//
// Usage: node scripts/demo-vault/build-demo-vault.mjs
// Resumable: every HTTP GET is cached under scripts/demo-vault/cache/, so
// re-running after a timeout continues where it left off.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const CACHE_DIR = path.join(ROOT, 'scripts', 'demo-vault', 'cache');
const OUT_DIR = path.join(ROOT, 'demo');
// Esplora-compatible public APIs, tried in order (mempool.space throttles
// sustained scanning; blockstream.info serves the same API shape).
const API_BASES = ['https://blockstream.info/api', 'https://mempool.space/api'];
const REQUEST_DELAY_MS = 250;

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// Stable "now" for reproducible metadata within one output file.
const BUILD_TIME = Date.now();

// ---------------------------------------------------------------------------
// HTTP with disk cache + rate limit + retries
// ---------------------------------------------------------------------------
let lastRequestAt = 0;
let httpCount = 0;

// Bounded-concurrency map (network is latency-bound, not bandwidth-bound).
async function pmap(items, fn, limit = 4) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

async function getJSON(apiPath, { optional = false } = {}) {
  const cacheFile = path.join(CACHE_DIR, sha1(apiPath) + '.json');
  if (fs.existsSync(cacheFile)) {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastRequestAt + REQUEST_DELAY_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    httpCount++;
    const base = API_BASES[attempt % API_BASES.length];
    try {
      const res = await fetch(base + apiPath, { signal: AbortSignal.timeout(20000) });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        if (optional) return null;
        throw new Error(`HTTP ${res.status} for ${apiPath}`);
      }
      const data = await res.json();
      fs.writeFileSync(cacheFile, JSON.stringify(data));
      return data;
    } catch (err) {
      if (attempt === 3) {
        if (optional) return null;
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return null;
}

const addressStats = (a) => getJSON(`/address/${a}`, { optional: true });

// Confirmed tx pages (25/page). Returns esplora tx objects.
async function addressTxs(a, maxPages) {
  const all = [];
  let last = '';
  for (let p = 0; p < maxPages; p++) {
    const page = await getJSON(`/address/${a}/txs/chain${last ? '/' + last : ''}`, {
      optional: true,
    });
    if (!page || page.length === 0) break;
    all.push(...page);
    if (page.length < 25) break;
    last = page[page.length - 1].txid;
  }
  return all.filter((t) => t.status && t.status.confirmed);
}

// ---------------------------------------------------------------------------
// Bundled entity list (parsed from the app source; single source of truth)
// ---------------------------------------------------------------------------
function loadBundledEntities() {
  const src = fs.readFileSync(
    path.join(ROOT, 'client', 'src', 'lib', 'privacy-entity-list.ts'),
    'utf8',
  );
  const re = /\{\s*address:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*category:\s*"([^"]+)"/g;
  const out = new Map();
  let m;
  while ((m = re.exec(src))) out.set(m[1], { name: m[2], category: m[3] });
  return out;
}

// Deterministic ordering helper (stable "shuffle" independent of Map order).
const byHash = (a, b) => sha1(a).localeCompare(sha1(b));

const detectScriptType = (addr) => {
  if (!addr) return 'unknown';
  if (addr.startsWith('bc1p')) return 'v1_p2tr';
  if (addr.startsWith('bc1q')) return addr.length > 42 ? 'v0_p2wsh' : 'v0_p2wpkh';
  if (addr.startsWith('3')) return 'p2sh';
  if (addr.startsWith('1')) return 'p2pkh';
  return 'unknown';
};

// ---------------------------------------------------------------------------
// Phase 1: choose entity seeds
// ---------------------------------------------------------------------------
async function chooseEntitySeeds(entities) {
  const byCategory = new Map();
  for (const [addr, e] of entities) {
    if (!byCategory.has(e.category)) byCategory.set(e.category, []);
    byCategory.get(e.category).push(addr);
  }
  const seeds = [];
  for (const cat of ['exchange', 'mixer', 'scam', 'darknet', 'gambling']) {
    const list = (byCategory.get(cat) || []).sort(byHash).slice(0, 8);
    const stats = await pmap(list, (a) => addressStats(a));
    let taken = 0;
    list.forEach((addr, i) => {
      const st = stats[i];
      if (taken < 3 && seeds.length < 14 && st && st.chain_stats && st.chain_stats.tx_count >= 4) {
        seeds.push({ addr, category: cat, txCount: st.chain_stats.tx_count });
        taken++;
      }
    });
  }
  return seeds;
}

// ---------------------------------------------------------------------------
// Phase 2: harvest counterparties of entity seeds → owned candidates
// ---------------------------------------------------------------------------
function txAddresses(tx) {
  const ins = tx.vin
    .map((v) => v.prevout && v.prevout.scriptpubkey_address)
    .filter(Boolean);
  const outs = tx.vout.map((v) => v.scriptpubkey_address).filter(Boolean);
  return { ins, outs };
}

async function pickOwned(entityTxsByAddr, entities) {
  const candidateFreq = new Map();
  for (const [, txs] of entityTxsByAddr) {
    for (const tx of txs) {
      const { ins, outs } = txAddresses(tx);
      for (const a of [...ins, ...outs]) {
        if (entities.has(a)) continue;
        candidateFreq.set(a, (candidateFreq.get(a) || 0) + 1);
      }
    }
  }
  const candidates = [...candidateFreq.keys()].sort(byHash).slice(0, 220);
  const stats = await pmap(candidates, (a) => addressStats(a));
  const owned = [];
  candidates.forEach((a, i) => {
    if (owned.length >= 30) return;
    const st = stats[i];
    if (!st || !st.chain_stats) return;
    const txc = st.chain_stats.tx_count;
    if (txc < 3 || txc > 80) return;
    const type = detectScriptType(a);
    if (type === 'unknown') return;
    owned.push({ addr: a, txCount: txc, type });
  });
  return owned;
}

// ---------------------------------------------------------------------------
// Phase 3/4: fetch owned histories + gap-fill patterns + watch (hop-2) set
// ---------------------------------------------------------------------------
async function fetchOwnedHistories(owned) {
  const pages = await pmap(owned, (o) => addressTxs(o.addr, 3)); // up to 75 txs each
  const txsByOwned = new Map();
  owned.forEach((o, i) => txsByOwned.set(o.addr, pages[i]));
  return txsByOwned;
}

function findDustRecipient(allTxs, exclude) {
  for (const tx of allTxs) {
    for (const v of tx.vout) {
      const a = v.scriptpubkey_address;
      if (a && v.value > 0 && v.value <= 1000 && !exclude.has(a)) return a;
    }
  }
  return null;
}

function findSpentP2pkh(allTxs, exclude) {
  for (const tx of allTxs) {
    for (const vin of tx.vin) {
      const a = vin.prevout && vin.prevout.scriptpubkey_address;
      if (a && a.startsWith('1') && !exclude.has(a)) return a;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fingerprint helpers (from raw esplora tx data)
// ---------------------------------------------------------------------------
function isBip69Ordered(tx) {
  for (let i = 1; i < tx.vin.length; i++) {
    const a = tx.vin[i - 1];
    const b = tx.vin[i];
    const c = a.txid.localeCompare(b.txid);
    if (c > 0 || (c === 0 && a.vout > b.vout)) return false;
  }
  for (let i = 1; i < tx.vout.length; i++) {
    const a = tx.vout[i - 1];
    const b = tx.vout[i];
    if (a.value > b.value) return false;
    if (a.value === b.value && (a.scriptpubkey || '').localeCompare(b.scriptpubkey || '') > 0)
      return false;
  }
  return true;
}

function hasLowRSig(tx) {
  // Best effort: DER sig starts 0x30 <len> 0x02 <rlen>; low-R iff rlen == 0x20.
  for (const vin of tx.vin) {
    const w = vin.witness;
    const cand = [];
    if (Array.isArray(w) && w[0]) cand.push(w[0]);
    if (vin.scriptsig && vin.scriptsig.length > 18) cand.push(vin.scriptsig.slice(2));
    for (const hexSig of cand) {
      if (hexSig.startsWith('30') && hexSig.slice(4, 6) === '02' && hexSig.slice(6, 8) === '20')
        return true;
    }
  }
  return false;
}

function toBlockchainTransaction(tx) {
  const vsize = Math.ceil(tx.weight / 4);
  const witnessFlags = tx.vin.map((v) => Array.isArray(v.witness) && v.witness.length > 0);
  const anyWitness = witnessFlags.some(Boolean);
  const opReturns = [];
  tx.vout.forEach((v, i) => {
    if (v.scriptpubkey_type === 'op_return') {
      const dataHex = (v.scriptpubkey || '').replace(/^6a(4c)?[0-9a-f]{2}/, '');
      opReturns.push({ vout: i, dataHex });
    }
  });
  return {
    txid: tx.txid,
    blockHeight: tx.status.block_height,
    blockTime: tx.status.block_time,
    fee: tx.fee || 0,
    feeRate: vsize > 0 ? Math.round(((tx.fee || 0) / vsize) * 100) / 100 : 0,
    syncedAt: BUILD_TIME,
    size: tx.size,
    weight: tx.weight,
    vsize,
    hasOpReturn: opReturns.length > 0,
    ...(opReturns.length > 0 ? { opReturnData: opReturns } : {}),
    rawFingerprintCaptured: true,
    nVersion: tx.version,
    nLockTime: tx.locktime,
    hasRbf: tx.vin.every((v) => v.sequence < 0xfffffffe),
    isBip69Ordered: isBip69Ordered(tx),
    hasLowRSig: hasLowRSig(tx),
    hasWitness: anyWitness,
    hasMixedWitness: anyWitness && witnessFlags.some((f) => !f),
    hasCoinbaseInput: tx.vin.some((v) => v.is_coinbase),
  };
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------
const PERSONAS = [
  {
    owner: 'Avery Stone',
    walletName: 'Glacier Cold Storage',
    seedName: 'Glacier Seed',
    walletSoftware: 'Sparrow',
    tags: ['demo', 'long-term-hold'],
    categories: ['Savings'],
    labelPrefix: 'Cold storage',
    importance: 'verified',
    source: 'manual',
  },
  {
    owner: 'Blake Rivera',
    walletName: 'Trading Hot Wallet',
    seedName: 'Hot Wallet Seed',
    walletSoftware: 'Electrum',
    tags: ['demo', 'trading', 'kyc-exchange'],
    categories: ['Trading'],
    labelPrefix: 'Exchange withdrawal',
    importance: 'wallet-import',
    source: 'wallet-import',
  },
  {
    owner: 'Casey Mora',
    walletName: 'Shop Register',
    seedName: 'Shop Seed',
    walletSoftware: 'BTCPay Server',
    tags: ['demo', 'merchant-income'],
    categories: ['Business Income'],
    labelPrefix: 'Shop payment address',
    importance: 'manual',
    source: 'manual',
  },
  {
    owner: 'Dana & Eli Family Trust',
    walletName: 'Meridian Vault 2-of-3',
    seedName: 'Meridian Vault Keys',
    walletSoftware: 'Sparrow',
    tags: ['demo', 'multisig', 'family-trust'],
    categories: ['Savings'],
    labelPrefix: 'Vault address',
    importance: 'xpub-derived',
    source: 'xpub-import',
    vault: { isVaultXpub: true, vaultName: 'Meridian Vault 2-of-3', m: 2, n: 3 },
  },
];

function personaFor(ownedEntry, idx) {
  const t = ownedEntry.type;
  if (t === 'p2sh' || t === 'v0_p2wsh') return PERSONAS[3];
  if (ownedEntry.role === 'dust' || ownedEntry.role === 'reuse') return PERSONAS[2];
  if (ownedEntry.role === 'quantum') return PERSONAS[0];
  if (ownedEntry.txCount >= 15) return PERSONAS[1];
  return PERSONAS[[0, 1, 2][idx % 3]];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('== KYUTXO demo vault builder ==');
  const entities = loadBundledEntities();
  console.log(`Bundled entity list: ${entities.size} entries`);

  // 1) entity seeds
  const seeds = await chooseEntitySeeds(entities);
  console.log(`Entity seeds (${seeds.length}):`, seeds.map((s) => `${s.category}:${s.addr.slice(0, 8)}…(${s.txCount})`).join(' '));

  // 2) entity seed tx pages (2 pages each; only used for harvesting + any tx
  //    that later turns out to touch an owned address)
  const entityTxsByAddr = new Map();
  const seedPages = await pmap(seeds, (s) => addressTxs(s.addr, 2));
  seeds.forEach((s, i) => entityTxsByAddr.set(s.addr, seedPages[i]));

  // 3) owned selection
  const owned = await pickOwned(entityTxsByAddr, entities);
  console.log(`Owned addresses adopted: ${owned.length}`);
  if (owned.length < 10) throw new Error('Too few owned candidates — widen probe limits.');

  // 4) owned histories
  let txsByOwned = await fetchOwnedHistories(owned);
  const ownedSet = () => new Set(owned.map((o) => o.addr));

  // 5) gap-fill: dust / quantum / reuse
  const allOwnedTxs = () => [...txsByOwned.values()].flat();
  const outputsToOwned = (predicate) =>
    allOwnedTxs().some((tx) =>
      tx.vout.some((v) => v.scriptpubkey_address && ownedSet().has(v.scriptpubkey_address) && predicate(v)),
    );

  if (!outputsToOwned((v) => v.value > 0 && v.value <= 1000)) {
    const excl = new Set([...ownedSet(), ...entities.keys()]);
    const dustAddr = findDustRecipient([...entityTxsByAddr.values()].flat().concat(allOwnedTxs()), excl);
    if (dustAddr) {
      console.log('Gap-fill: adopting dust recipient', dustAddr);
      owned.push({ addr: dustAddr, txCount: 0, type: detectScriptType(dustAddr), role: 'dust' });
      txsByOwned.set(dustAddr, await addressTxs(dustAddr, 2));
    }
  }

  const hasSpentP2pkhOwned = () =>
    allOwnedTxs().some((tx) =>
      tx.vin.some((v) => {
        const a = v.prevout && v.prevout.scriptpubkey_address;
        return a && a.startsWith('1') && ownedSet().has(a);
      }),
    );
  if (!hasSpentP2pkhOwned()) {
    const excl = new Set([...ownedSet(), ...entities.keys()]);
    const qa = findSpentP2pkh([...entityTxsByAddr.values()].flat().concat(allOwnedTxs()), excl);
    if (qa) {
      console.log('Gap-fill: adopting spent-from P2PKH', qa);
      owned.push({ addr: qa, txCount: 0, type: 'p2pkh', role: 'quantum' });
      txsByOwned.set(qa, await addressTxs(qa, 2));
    }
  }

  const receiptCount = (addr) => {
    let n = 0;
    for (const tx of txsByOwned.get(addr) || [])
      for (const v of tx.vout) if (v.scriptpubkey_address === addr) n++;
    return n;
  };
  if (!owned.some((o) => receiptCount(o.addr) >= 10)) {
    // adopt a busier counterparty as the merchant reuse address
    const excl = new Set([...ownedSet(), ...entities.keys()]);
    const freq = new Map();
    for (const tx of allOwnedTxs()) {
      const { outs } = txAddresses(tx);
      for (const a of outs) if (!excl.has(a)) freq.set(a, (freq.get(a) || 0) + 1);
    }
    for (const a of [...freq.keys()].sort(byHash)) {
      const st = await addressStats(a);
      if (st && st.chain_stats.tx_count >= 12 && st.chain_stats.tx_count <= 90) {
        console.log('Gap-fill: adopting reused address', a);
        owned.push({ addr: a, txCount: st.chain_stats.tx_count, type: detectScriptType(a), role: 'reuse' });
        txsByOwned.set(a, await addressTxs(a, 4));
        break;
      }
    }
  }

  // 6) watch set (hop-2): frequent counterparties of owned txs
  const ownedAddrs = ownedSet();
  const cpFreq = new Map();
  for (const tx of allOwnedTxs()) {
    const { ins, outs } = txAddresses(tx);
    for (const a of [...ins, ...outs]) {
      if (ownedAddrs.has(a) || entities.has(a)) continue;
      cpFreq.set(a, (cpFreq.get(a) || 0) + 1);
    }
  }
  const watch = [...cpFreq.entries()]
    .sort((x, y) => y[1] - x[1] || byHash(x[0], y[0]))
    .slice(0, 40)
    .map(([a]) => a);
  const txsByWatch = new Map();
  const watchPages = await pmap(watch, (a) => addressTxs(a, 1));
  watch.forEach((a, i) => txsByWatch.set(a, watchPages[i]));
  console.log(`Watch (hop-2) addresses: ${watch.length}`);

  // ---------------------------------------------------------------------
  // Assemble transaction set
  // ---------------------------------------------------------------------
  const txMap = new Map(); // txid -> esplora tx
  const involvesOwned = (tx) => {
    const { ins, outs } = txAddresses(tx);
    return [...ins, ...outs].some((a) => ownedAddrs.has(a));
  };
  const addTx = (tx) => {
    if (txMap.has(tx.txid)) return;
    const nParts = tx.vin.length + tx.vout.length;
    if (nParts > (involvesOwned(tx) ? 400 : 60)) return;
    txMap.set(tx.txid, tx);
  };
  for (const txs of txsByOwned.values()) txs.forEach(addTx);
  for (const txs of txsByWatch.values()) txs.forEach(addTx);
  // entity txs only when they touch an owned address (usually already present)
  for (const txs of entityTxsByAddr.values()) txs.filter(involvesOwned).forEach(addTx);

  const txs = [...txMap.values()].sort((a, b) => a.status.block_time - b.status.block_time);
  console.log(`Transactions: ${txs.length}`);

  // ---------------------------------------------------------------------
  // Records
  // ---------------------------------------------------------------------
  const records = [];
  const recordIdByAddress = new Map();
  const pushRecord = (rec) => {
    const id = records.length + 1;
    records.push({ id, ...rec });
    recordIdByAddress.set(rec.inputString, id);
    return id;
  };

  const perPersonaCounter = new Map();
  owned.forEach((o, idx) => {
    const p = personaFor(o, idx);
    const n = (perPersonaCounter.get(p.owner) || 0) + 1;
    perPersonaCounter.set(p.owner, n);
    const roleBits =
      o.role === 'dust'
        ? { label: 'Dusted deposit address (incident 2024)', tags: [...p.tags, 'dusting-incident'] }
        : o.role === 'reuse'
          ? { label: 'Shop donation address (reused)', tags: [...p.tags, 'address-reuse'] }
          : o.role === 'quantum'
            ? { label: 'Legacy P2PKH (pubkey exposed)', tags: [...p.tags, 'legacy'] }
            : { label: `${p.labelPrefix} #${n}`, tags: p.tags };
    pushRecord({
      type: 'address',
      inputString: o.addr,
      inputStringLower: o.addr.toLowerCase(),
      label: roleBits.label,
      notes: `Demo persona address (${p.owner}). Real on-chain history; fictional attribution.`,
      tags: roleBits.tags,
      categories: p.categories,
      owner: p.owner,
      walletName: p.walletName,
      seedName: p.seedName,
      walletSoftware: p.walletSoftware,
      source: p.source,
      addressImportance: p.importance,
      ...(p.vault ? { vault: p.vault } : {}),
      createdAt: BUILD_TIME - 90 * 86400e3 + idx * 3600e3,
      updatedAt: BUILD_TIME - 86400e3,
    });
  });

  // Entity + hop-1 counterparty records for addresses present in stored txs.
  const seen = new Map(); // addr -> {freq, firstTxid}
  for (const tx of txs) {
    const { ins, outs } = txAddresses(tx);
    for (const a of [...ins, ...outs]) {
      if (recordIdByAddress.has(a)) continue;
      const s = seen.get(a);
      if (s) s.freq++;
      else seen.set(a, { freq: 1, firstTxid: tx.txid });
    }
  }
  const CP_TYPE = { exchange: 'exchange', mixer: 'mixer', 'mining-pool': 'mining-pool' };
  // Entities first
  for (const [a, info] of seen) {
    const e = entities.get(a);
    if (!e) continue;
    pushRecord({
      type: 'address',
      inputString: a,
      inputStringLower: a.toLowerCase(),
      label: `${e.name} (${e.category})`,
      tags: ['demo', 'entity-list'],
      categories: [],
      counterpartyType: CP_TYPE[e.category] || 'business',
      counterpartyName: e.name,
      source: 'sync',
      addressImportance: 'blockchain-discovered',
      syncDepth: 1,
      discoveredInTxid: info.firstTxid,
      createdAt: BUILD_TIME - 80 * 86400e3,
      updatedAt: BUILD_TIME - 86400e3,
    });
  }
  // Then plain counterparties by frequency, respecting the total budget.
  const targetTotal = Math.min(9000, Math.max(5200, txs.length + 2600));
  const cpBudget = Math.max(0, targetTotal - txs.length - records.length);
  const plainCps = [...seen.entries()]
    .filter(([a]) => !recordIdByAddress.has(a))
    .sort((x, y) => y[1].freq - x[1].freq || byHash(x[0], y[0]))
    .slice(0, cpBudget);
  plainCps.forEach(([a, info], i) => {
    pushRecord({
      type: 'address',
      inputString: a,
      inputStringLower: a.toLowerCase(),
      label: `Observed counterparty #${i + 1}`,
      tags: ['demo', 'discovered'],
      categories: [],
      source: 'sync',
      addressImportance: 'blockchain-discovered',
      syncDepth: watch.includes(a) ? 1 : 2,
      discoveredInTxid: info.firstTxid,
      createdAt: BUILD_TIME - 70 * 86400e3 + i * 1000,
      updatedAt: BUILD_TIME - 86400e3,
    });
  });
  console.log(`Records: ${records.length} (owned ${owned.length})`);

  // ---------------------------------------------------------------------
  // Participants
  // ---------------------------------------------------------------------
  const participants = [];
  let pid = 1;
  for (const tx of txs) {
    tx.vin.forEach((vin) => {
      if (vin.is_coinbase) return;
      const a = vin.prevout && vin.prevout.scriptpubkey_address;
      participants.push({
        id: pid++,
        txid: tx.txid,
        role: 'input',
        address: a || 'unknown',
        amount: (vin.prevout && vin.prevout.value) || 0,
        prevTxid: vin.txid,
        prevVout: vin.vout,
        ...(a && recordIdByAddress.has(a) ? { recordId: recordIdByAddress.get(a) } : {}),
        scriptType: (vin.prevout && vin.prevout.scriptpubkey_type) || 'unknown',
      });
    });
    tx.vout.forEach((v, i) => {
      participants.push({
        id: pid++,
        txid: tx.txid,
        role: 'output',
        address: v.scriptpubkey_address || 'unknown',
        amount: v.value,
        vout: i,
        ...(v.scriptpubkey_address && recordIdByAddress.has(v.scriptpubkey_address)
          ? { recordId: recordIdByAddress.get(v.scriptpubkey_address) }
          : {}),
        scriptType: v.scriptpubkey_type || 'unknown',
      });
    });
  }
  console.log(`Participants: ${participants.length}`);

  // ---------------------------------------------------------------------
  // Per-address cached stats — ONLY for curated (owned) records.
  // ---------------------------------------------------------------------
  const spentOutpoints = new Set();
  for (const p of participants)
    if (p.role === 'input' && p.prevTxid != null) spentOutpoints.add(`${p.prevTxid}:${p.prevVout}`);
  const txTimeById = new Map(txs.map((t) => [t.txid, t.status.block_time]));
  const statsByAddr = new Map();
  for (const p of participants) {
    if (p.address === 'unknown') continue;
    let s = statsByAddr.get(p.address);
    if (!s) statsByAddr.set(p.address, (s = { bal: 0, txids: new Set(), last: 0, utxo: 0 }));
    s.txids.add(p.txid);
    s.last = Math.max(s.last, txTimeById.get(p.txid) || 0);
    if (p.role === 'output') {
      s.bal += p.amount;
      if (!spentOutpoints.has(`${p.txid}:${p.vout}`)) s.utxo++;
    } else {
      s.bal -= p.amount;
    }
  }
  for (const rec of records) {
    const s = statsByAddr.get(rec.inputString);
    if (!s) continue;
    rec.firstSeenBlockTime = Math.min(
      ...[...s.txids].map((t) => txTimeById.get(t) || Infinity),
    );
    if (rec.addressImportance !== 'blockchain-discovered') {
      rec.cachedBalanceSats = Math.max(0, s.bal);
      rec.cachedTxCount = s.txids.size;
      rec.cachedLastActivityTime = s.last;
      rec.cachedUtxoCount = s.utxo;
      rec.statsComputedAt = BUILD_TIME;
    }
  }

  // ---------------------------------------------------------------------
  // addressSyncState (owned only)
  // ---------------------------------------------------------------------
  const tipHeight = txs.reduce((m, t) => Math.max(m, t.status.block_height), 0);
  const syncState = owned.map((o, i) => ({
    id: i + 1,
    address: o.addr,
    recordId: recordIdByAddress.get(o.addr),
    lastSyncedHeight: tipHeight,
    lastSyncedAt: BUILD_TIME,
    txCount: (txsByOwned.get(o.addr) || []).length,
  }));

  // ---------------------------------------------------------------------
  // utxoLineage + custodySegments
  // ---------------------------------------------------------------------
  const lineage = [];
  let lid = 1;
  const isOwnedAddr = (a) => ownedAddrs.has(a);
  for (const tx of txs) {
    if (tx.vin.length > 6 || tx.vout.length > 6) continue;
    const ins = tx.vin
      .filter((v) => v.prevout && v.prevout.scriptpubkey_address)
      .map((v) => ({
        addr: v.prevout.scriptpubkey_address,
        amount: v.prevout.value,
        txid: v.txid,
        vout: v.vout,
      }));
    const outs = tx.vout
      .map((v, i) => ({ addr: v.scriptpubkey_address, amount: v.value, vout: i }))
      .filter((o) => o.addr);
    const touchesOwned =
      ins.some((i) => isOwnedAddr(i.addr)) || outs.some((o) => isOwnedAddr(o.addr));
    if (!touchesOwned) continue;
    for (const i of ins) {
      for (const o of outs) {
        if (lineage.length >= 4000) break;
        const so = isOwnedAddr(i.addr);
        const co = isOwnedAddr(o.addr);
        lineage.push({
          id: lid++,
          spentTxid: i.txid,
          spentVout: i.vout,
          spentAddress: i.addr,
          spentAmount: i.amount,
          consumingTxid: tx.txid,
          createdTxid: tx.txid,
          createdVout: o.vout,
          createdAddress: o.addr,
          createdAmount: o.amount,
          spentOwned: so,
          createdOwned: co,
          isChange: so && co,
          confidence: so && co ? 'high' : so || co ? 'medium' : 'low',
          blockTime: tx.status.block_time,
          blockHeight: tx.status.block_height,
          createdAt: BUILD_TIME,
        });
      }
    }
  }
  console.log(`Lineage rows: ${lineage.length}`);

  // Custody segments: one per owned funding UTXO (capped), walking spends.
  const spendByOutpoint = new Map(); // "txid:vout" -> consuming tx
  for (const tx of txs)
    for (const vin of tx.vin)
      if (vin.txid != null) spendByOutpoint.set(`${vin.txid}:${vin.vout}`, tx);
  const segments = [];
  const recById = new Map(records.map((r) => [r.id, r]));
  outer: for (const o of owned) {
    const rec = recById.get(recordIdByAddress.get(o.addr));
    let taken = 0;
    for (const tx of txsByOwned.get(o.addr) || []) {
      if (taken >= 2) continue;
      const vIdx = tx.vout.findIndex((v) => v.scriptpubkey_address === o.addr);
      if (vIdx < 0) continue;
      taken++;
      const segmentId = crypto
        .createHash('sha1')
        .update(`seg:${tx.txid}:${vIdx}`)
        .digest('hex')
        .slice(0, 32);
      const evidence = [tx.txid];
      let cur = { txid: tx.txid, vout: vIdx, addr: o.addr, amount: tx.vout[vIdx].value };
      let hops = 0;
      let status = 'active';
      for (let h = 0; h < 6; h++) {
        const next = spendByOutpoint.get(`${cur.txid}:${cur.vout}`);
        if (!next) break;
        evidence.push(next.txid);
        hops++;
        const nIdx = next.vout.findIndex(
          (v) => v.scriptpubkey_address && isOwnedAddr(v.scriptpubkey_address),
        );
        if (nIdx < 0) {
          status = 'spent';
          const ext = next.vout.find((v) => v.scriptpubkey_address);
          cur = {
            txid: next.txid,
            vout: next.vout.indexOf(ext),
            addr: ext ? ext.scriptpubkey_address : cur.addr,
            amount: ext ? ext.value : 0,
          };
          break;
        }
        cur = {
          txid: next.txid,
          vout: nIdx,
          addr: next.vout[nIdx].scriptpubkey_address,
          amount: next.vout[nIdx].value,
        };
        status = 'transferred';
      }
      segments.push({
        id: segments.length + 1,
        segmentId,
        originTxid: tx.txid,
        originVout: vIdx,
        originAddress: o.addr,
        originDate: tx.status.block_time, // Unix SECONDS (consumers multiply by 1000)
        originAmount: tx.vout[vIdx].value,
        acquisitionMethod: rec && rec.owner === 'Blake Rivera' ? 'exchange-purchase' : 'transfer-in',
        currentTxid: cur.txid,
        currentVout: cur.vout,
        currentAddress: cur.addr,
        currentAmount: cur.amount,
        status: hops === 0 ? 'active' : status,
        hopCount: hops,
        evidenceTxids: evidence,
        narrative: `Demo custody chain for ${rec ? rec.label : o.addr}: ${evidence.length} transaction(s), ${hops} hop(s).`,
        owner: rec && rec.owner,
        walletName: rec && rec.walletName,
        createdAt: BUILD_TIME,
        updatedAt: BUILD_TIME,
      });
      if (segments.length >= 120) break outer;
    }
  }
  console.log(`Custody segments: ${segments.length}`);

  // ---------------------------------------------------------------------
  // Demo entity-list snapshot (fills gaps so mixer/scam findings fire)
  // ---------------------------------------------------------------------
  const DEMO_ENTITY_CATS = [
    ['exchange', 'Demo OTC Desk'],
    ['mixer', 'Demo Mixing Service'],
    ['scam', 'Demo HYIP Collector'],
  ];
  const demoEntities = [];
  const hop1Freq = [...cpFreq.entries()].sort(
    (x, y) => y[1] - x[1] || byHash(x[0], y[0]),
  );
  for (const [a, f] of hop1Freq) {
    if (demoEntities.length >= 12) break;
    if (f < 2 || entities.has(a) || ownedAddrs.has(a)) continue;
    const [category, base] = DEMO_ENTITY_CATS[demoEntities.length % DEMO_ENTITY_CATS.length];
    demoEntities.push({
      address: a,
      name: `${base} ${Math.floor(demoEntities.length / 3) + 1}`,
      category,
      sourceNote:
        'KYUTXO demo dataset — fictional attribution applied to a real address for demonstration only',
    });
  }
  fs.writeFileSync(
    path.join(OUT_DIR, 'demo-entity-list.json'),
    JSON.stringify({ entries: demoEntities }, null, 2),
  );

  // ---------------------------------------------------------------------
  // Inline tables
  // ---------------------------------------------------------------------
  const uniq = (arr) => [...new Set(arr)];
  const TAG_COLORS = ['#f97316', '#22c55e', '#3b82f6', '#a855f7', '#ef4444', '#eab308', '#14b8a6'];
  const allTags = uniq(records.flatMap((r) => r.tags || []));
  const inline = {
    tags: allTags.map((name, i) => ({ id: i + 1, name, color: TAG_COLORS[i % TAG_COLORS.length], createdAt: BUILD_TIME })),
    categories: uniq(records.flatMap((r) => r.categories || [])).map((name, i) => ({ id: i + 1, name, createdAt: BUILD_TIME })),
    owners: uniq(records.map((r) => r.owner).filter(Boolean)).map((name, i) => ({ id: i + 1, name, createdAt: BUILD_TIME })),
    walletNames: uniq(records.map((r) => r.walletName).filter(Boolean)).map((name, i) => ({ id: i + 1, name, createdAt: BUILD_TIME })),
    seedNames: uniq(records.map((r) => r.seedName).filter(Boolean)).map((name, i) => ({ id: i + 1, name, createdAt: BUILD_TIME })),
    walletSoftware: uniq(records.map((r) => r.walletSoftware).filter(Boolean)).map((name, i) => ({ id: i + 1, name, createdAt: BUILD_TIME })),
    recordOrigins: [],
    customFields: [],
    derivationTemplates: [],
    evidence: [],
    evidenceAttachments: [],
    priceData: [],
    settings: [
      {
        id: 'default',
        entityListSnapshot: {
          importedAt: BUILD_TIME,
          sourceLabel: 'KYUTXO demo dataset',
          mode: 'merge',
          entries: demoEntities,
        },
      },
    ],
    nodeSettings: [],
    dustFlags: [],
  };

  // ---------------------------------------------------------------------
  // v3 ZIP
  // ---------------------------------------------------------------------
  const BATCH = 500;
  const ndjson = (rows) => {
    let out = '';
    for (let i = 0; i < rows.length; i += BATCH) {
      out += JSON.stringify(rows.slice(i, i + BATCH)) + '\n';
    }
    return out;
  };
  const counts = {
    records: records.length,
    blockchainTransactions: txs.length,
    transactionParticipants: participants.length,
    attachments: 0,
    addressSyncState: syncState.length,
    utxoLineage: lineage.length,
    custodySegments: segments.length,
    lineageSnapshots: 0,
    attachmentFiles: 0,
  };
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const manifest = {
    formatVersion: 3,
    app: 'KYUTXO',
    appVersion: pkg.version || '3.0.0',
    exportDate: new Date(BUILD_TIME).toISOString(),
    encrypted: false,
    counts,
    totalAttachmentBytes: 0,
    streamedTables: [
      'records',
      'attachments',
      'transactionParticipants',
      'addressSyncState',
      'blockchainTransactions',
      'utxoLineage',
      'custodySegments',
      'lineageSnapshots',
    ],
    inline,
  };
  const blockchainTxRows = txs.map((t, i) => ({ id: i + 1, ...toBlockchainTransaction(t) }));
  const zipEntries = {
    'backup.json': strToU8(JSON.stringify(manifest)),
    'tables/records.ndjson': strToU8(ndjson(records)),
    'tables/attachments.ndjson': strToU8(''),
    'tables/transactionParticipants.ndjson': strToU8(ndjson(participants)),
    'tables/addressSyncState.ndjson': strToU8(ndjson(syncState)),
    'tables/blockchainTransactions.ndjson': strToU8(ndjson(blockchainTxRows)),
    'tables/utxoLineage.ndjson': strToU8(ndjson(lineage)),
    'tables/custodySegments.ndjson': strToU8(ndjson(segments)),
    'tables/lineageSnapshots.ndjson': strToU8(''),
  };
  const zip = zipSync(zipEntries, { level: 6 });
  const zipPath = path.join(OUT_DIR, 'kyutxo-demo-vault.zip');
  fs.writeFileSync(zipPath, zip);
  console.log(`Wrote ${zipPath} (${(zip.length / 1024 / 1024).toFixed(2)} MB)`);

  // ---------------------------------------------------------------------
  // Coverage matrix
  // ---------------------------------------------------------------------
  const demoEntityAddrs = new Set(demoEntities.map((e) => e.address));
  const entityAddrsInTxs = new Set();
  for (const p of participants)
    if (entities.has(p.address) || demoEntityAddrs.has(p.address)) entityAddrsInTxs.add(p.address);
  const directEntityContact = txs.some((tx) => {
    const { ins, outs } = txAddresses(tx);
    const all = [...ins, ...outs];
    return (
      all.some((a) => ownedAddrs.has(a)) &&
      all.some((a) => entities.has(a) || demoEntityAddrs.has(a))
    );
  });
  const times = txs.map((t) => t.status.block_time);
  const spanDays = (Math.max(...times) - Math.min(...times)) / 86400;
  const maxReuse = Math.max(...owned.map((o) => receiptCount(o.addr)), 0);
  const dustToOwned = participants.some(
    (p) => p.role === 'output' && p.amount > 0 && p.amount <= 1000 && ownedAddrs.has(p.address),
  );
  const quantum = participants.some(
    (p) => p.role === 'input' && p.address.startsWith('1') && ownedAddrs.has(p.address),
  );
  const p2wshOutputs = participants.filter(
    (p) => p.role === 'output' && p.scriptType === 'v0_p2wsh',
  ).length;
  const vaultRecords = records.filter((r) => r.vault).length;
  const multiHopSegments = segments.filter((s) => s.hopCount >= 2).length;
  const coSpend = txs.filter((t) => t.vin.length >= 2 && involvesOwned(t)).length;
  const total = records.length + txs.length;
  const matrix = {
    totals: { records: records.length, transactions: txs.length, participants: participants.length, combined: total, inRange: total >= 5000 && total <= 10000 },
    fundTrail: { lineageRows: lineage.length, custodySegments: segments.length, multiHopSegments, timeSpanDays: Math.round(spanDays), pass: lineage.length > 100 && spanDays > 180 },
    entityScreening: { bundledEntitiesPresent: [...entityAddrsInTxs].filter((a) => entities.has(a)).length, demoEntities: demoEntities.length, directOwnedContact: directEntityContact, pass: directEntityContact },
    addressReuse: { maxReceiptsOnOwned: maxReuse, pass: maxReuse >= 10 },
    dusted: { dustOutputToOwned: dustToOwned, pass: dustToOwned },
    quantumRisk: { spentFromOwnedP2pkh: quantum, pass: quantum },
    lightning: { p2wshOutputs, pass: p2wshOutputs > 0 },
    vaults: { vaultRecords, pass: vaultRecords >= 2 },
    adversaryClustering: { ownedCoSpendTxs: coSpend, pass: coSpend >= 3 },
    httpRequests: httpCount,
    // Presenter highlights: which real addresses/txids demonstrate what.
    highlights: {
      personas: PERSONAS.map((p) => ({
        owner: p.owner,
        walletName: p.walletName,
        addresses: records
          .filter((r) => r.owner === p.owner)
          .map((r) => ({ address: r.inputString, label: r.label })),
      })),
      entityContactTxids: txs
        .filter((tx) => {
          const { ins, outs } = txAddresses(tx);
          const all = [...ins, ...outs];
          return all.some((a) => ownedAddrs.has(a)) && all.some((a) => entities.has(a) || demoEntityAddrs.has(a));
        })
        .slice(0, 5)
        .map((t) => t.txid),
      dustExample: participants.find(
        (p) => p.role === 'output' && p.amount > 0 && p.amount <= 1000 && ownedAddrs.has(p.address),
      ),
      quantumAddress: (participants.find(
        (p) => p.role === 'input' && p.address.startsWith('1') && ownedAddrs.has(p.address),
      ) || {}).address,
      reuseAddress: (owned
        .map((o) => ({ addr: o.addr, receipts: receiptCount(o.addr) }))
        .sort((a, b) => b.receipts - a.receipts)[0] || {}),
      deepSegments: segments
        .filter((s) => s.hopCount >= 1)
        .slice(0, 5)
        .map((s) => ({ origin: s.originAddress, txids: s.evidenceTxids })),
    },
  };
  fs.writeFileSync(path.join(OUT_DIR, 'coverage-report.json'), JSON.stringify(matrix, null, 2));
  console.log('Coverage matrix:');
  console.log(JSON.stringify(matrix, null, 2));
  const fails = Object.entries(matrix).filter(([, v]) => v && typeof v === 'object' && 'pass' in v && !v.pass);
  if (!matrix.totals.inRange) fails.push(['totals', matrix.totals]);
  if (fails.length) {
    console.log('COVERAGE GAPS:', fails.map(([k]) => k).join(', '));
    process.exitCode = 2;
  } else {
    console.log('All coverage checks PASS');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
