const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const { SocksClient } = require('socks');
const { detectWorkingTorProxy } = require('./tor-proxy.cjs');
const {
  certStorePath,
  getPinnedCertificate,
  trustCertificate,
} = require('./electrum-cert-store.cjs');

bitcoin.initEccLib(ecc);

// Path of the persisted TOFU certificate trust store, configured by
// registerElectrumHandlers. When unset, self-signed certificates can never be
// trusted and only CA-verified connections succeed (fail closed).
let trustStorePath = null;

// Connection pool with health tracking and request multiplexing
const electrumPool = {
  connections: new Map(), // key -> { socket, host, port, useSSL, lastUsed, healthy, pendingMap, buffer, dataHandler }
  keepaliveInterval: null,
  KEEPALIVE_INTERVAL: 30000, // Ping every 30 seconds
  CONNECTION_TIMEOUT: 60000, // Close idle connections after 60 seconds
  MAX_RETRIES: 2,
  requestIdCounter: 0,
};

// Start keepalive timer
function startKeepalive() {
  if (electrumPool.keepaliveInterval) return;
  
  electrumPool.keepaliveInterval = setInterval(async () => {
    const now = Date.now();
    
    for (const [key, conn] of electrumPool.connections.entries()) {
      // Close idle connections (no pending requests for >60s)
      if (now - conn.lastUsed > electrumPool.CONNECTION_TIMEOUT && conn.pendingMap.size === 0) {
        console.log(`[Electrum Pool] Closing idle connection: ${key}`);
        try { conn.socket.destroy(); } catch (e) {}
        electrumPool.connections.delete(key);
        continue;
      }
      
      // Ping active connections to keep them alive (only if no pending requests)
      if (conn.healthy && conn.pendingMap.size === 0) {
        try {
          await pooledRequest(key, 'server.ping', [], 5000);
          conn.lastUsed = Date.now();
        } catch (e) {
          console.log(`[Electrum Pool] Keepalive failed for ${key}: ${e.message}`);
          conn.healthy = false;
          try { conn.socket.destroy(); } catch (e) {}
          electrumPool.connections.delete(key);
        }
      }
    }
  }, electrumPool.KEEPALIVE_INTERVAL);
}

// Stop keepalive and close all connections
function stopKeepalive() {
  if (electrumPool.keepaliveInterval) {
    clearInterval(electrumPool.keepaliveInterval);
    electrumPool.keepaliveInterval = null;
  }
  
  for (const [key, conn] of electrumPool.connections.entries()) {
    // Reject all pending requests
    for (const [id, pending] of conn.pendingMap.entries()) {
      pending.reject(new Error('Connection pool shutting down'));
    }
    conn.pendingMap.clear();
    try { conn.socket.destroy(); } catch (e) {}
  }
  electrumPool.connections.clear();
}

// Setup multiplexed data handler for a connection
function setupMultiplexedHandler(conn, key) {
  conn.buffer = '';
  conn.pendingMap = new Map(); // id -> { resolve, reject, timeoutId }
  
  conn.dataHandler = (data) => {
    conn.buffer += data.toString();
    
    // Process newline-delimited JSON responses
    const lines = conn.buffer.split('\n');
    conn.buffer = lines[lines.length - 1]; // Keep incomplete line in buffer
    
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      try {
        const response = JSON.parse(line);
        const id = response.id;
        
        if (id !== undefined && conn.pendingMap.has(id)) {
          const pending = conn.pendingMap.get(id);
          conn.pendingMap.delete(id);
          clearTimeout(pending.timeoutId);
          
          if (response.error) {
            pending.reject(new Error(response.error.message || JSON.stringify(response.error)));
          } else {
            pending.resolve(response.result);
          }
        }
      } catch (e) {
        // Invalid JSON, ignore
      }
    }
  };
  
  conn.socket.on('data', conn.dataHandler);
  
  conn.socket.on('error', (err) => {
    console.log(`[Electrum Pool] Socket error on ${key}: ${err.message}`);
    conn.healthy = false;
    // Reject all pending requests
    for (const [id, pending] of conn.pendingMap.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(`Socket error: ${err.message}`));
    }
    conn.pendingMap.clear();
    electrumPool.connections.delete(key);
  });
  
  conn.socket.on('close', () => {
    console.log(`[Electrum Pool] Socket closed: ${key}`);
    // Reject all pending requests
    for (const [id, pending] of conn.pendingMap.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Socket closed'));
    }
    conn.pendingMap.clear();
    electrumPool.connections.delete(key);
  });
}

// Send a request on a multiplexed pooled connection
function pooledRequest(key, method, params = [], timeout = 30000) {
  return new Promise((resolve, reject) => {
    const conn = electrumPool.connections.get(key);
    if (!conn || !conn.healthy || conn.socket.destroyed) {
      reject(new Error('Connection not available'));
      return;
    }
    
    const id = ++electrumPool.requestIdCounter;
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    
    const timeoutId = setTimeout(() => {
      conn.pendingMap.delete(id);
      // Reject ONLY this request — never destroy the shared multiplexed
      // socket here. Destroying it would cascade-fail every other in-flight
      // request (e.g. up to 7 healthy pipelined batch requests) and any
      // still-queued batch addresses just because one address was slow. Even
      // an "empty pendingMap" heuristic is unsafe: a batch pipeline can have
      // zero requests currently on the wire while workers still hold queued
      // addresses that need this connection. A truly dead socket is handled
      // by the normal error/close handlers and the keepalive/idle lifecycle;
      // a late response for this id is simply ignored by the data handler
      // (the pending entry is gone).
      console.log(`[Electrum Pool] Request timeout on ${key} for ${method}; rejecting only this request (${conn.pendingMap.size} others in flight, connection kept open)`);
      reject(new Error(`Request timeout after ${timeout/1000}s for ${method}`));
    }, timeout);
    
    conn.pendingMap.set(id, { resolve, reject, timeoutId });
    conn.lastUsed = Date.now();
    
    try {
      conn.socket.write(request);
    } catch (e) {
      conn.pendingMap.delete(id);
      clearTimeout(timeoutId);
      // Write error - mark unhealthy and close
      console.log(`[Electrum Pool] Write error on ${key}, marking connection unhealthy`);
      conn.healthy = false;
      try { conn.socket.destroy(); } catch (e2) {}
      electrumPool.connections.delete(key);
      reject(new Error(`Write error: ${e.message}`));
    }
  });
}

function addressToScripthash(address) {
  let scriptPubKey;
  try {
    // Decode the address to get the script
    const decoded = bitcoin.address.toOutputScript(address, bitcoin.networks.bitcoin);
    scriptPubKey = decoded;
  } catch (e) {
    // Try testnet
    try {
      const decoded = bitcoin.address.toOutputScript(address, bitcoin.networks.testnet);
      scriptPubKey = decoded;
    } catch (e2) {
      throw new Error(`Invalid Bitcoin address: ${address}`);
    }
  }
  
  // SHA256 hash of the scriptPubKey, then reverse byte order
  const hash = crypto.createHash('sha256').update(scriptPubKey).digest();
  const reversed = Buffer.from(hash).reverse();
  return reversed.toString('hex');
}

// Clean host input - strip protocol prefixes and trailing slashes
// Electrum uses raw TCP, not HTTP - common mistake to include http://
function cleanElectrumHost(host) {
  if (!host) return host;
  let cleaned = host.trim();
  // Remove protocol prefixes (Electrum uses raw TCP, not HTTP)
  cleaned = cleaned.replace(/^https?:\/\//i, '');
  // Remove trailing slashes
  cleaned = cleaned.replace(/\/+$/, '');
  return cleaned;
}

// Build a raw TCP socket to the Electrum server, either directly or through
// the configured Tor SOCKS proxy. The `socks` client always sends the
// destination as a domain name (ATYP domain), so resolution happens at the
// Tor exit — this is what lets .onion Electrum hosts work and keeps DNS from
// leaking to the local resolver.
async function createTcpSocket(cleanedHost, port, torOptions, timeout) {
  if (!torOptions || !torOptions.useTor) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: cleanedHost, port }, () => resolve(socket));
      socket.setTimeout(timeout);
      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error(`Connection timeout after ${timeout / 1000}s`));
      });
      socket.on('error', (err) => {
        reject(new Error(`Connection failed: ${err.message}`));
      });
    });
  }

  // Resolve the proxy URL: use the configured one, or auto-detect a running
  // Tor Browser / Tor service exactly like the HTTP Tor path does.
  const proxyUrl = torOptions.torProxyUrl || (await detectWorkingTorProxy());
  let parsed;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new Error(`Invalid Tor proxy URL: ${proxyUrl}`);
  }
  const proxyPort = parseInt(parsed.port || '9050', 10);

  try {
    const info = await SocksClient.createConnection({
      proxy: {
        host: parsed.hostname,
        port: proxyPort,
        type: 5,
      },
      command: 'connect',
      destination: { host: cleanedHost, port },
      timeout,
    });
    info.socket.setTimeout(timeout);
    return info.socket;
  } catch (err) {
    throw new Error(
      `Connection failed via Tor proxy ${proxyUrl}: ${err.message}. Make sure Tor is running.`,
    );
  }
}

// Flatten an X.509 name ({CN, O, OU, ...}) into a comparable string.
function flattenX509Name(name) {
  if (!name || typeof name !== 'object') return '';
  return Object.keys(name).sort().map((k) => `${k}=${name[k]}`).join(',');
}

// Structural self-signed check: with a detailed peer certificate Node sets
// issuerCertificate to the cert itself for self-signed leaves; fall back to
// comparing subject/issuer names when the chain object is unavailable.
function isStructurallySelfSigned(cert) {
  if (!cert) return false;
  if (cert.issuerCertificate && cert.issuerCertificate === cert) return true;
  const subject = flattenX509Name(cert.subject);
  return subject !== '' && subject === flattenX509Name(cert.issuer);
}

// Extract display metadata + SHA-256 fingerprint from a peer certificate.
function describeCertificate(cert) {
  if (!cert || !cert.raw || !cert.fingerprint256) return null;
  return {
    fingerprint: cert.fingerprint256,
    subject: cert.subject && (cert.subject.CN || cert.subject.O) ? (cert.subject.CN || cert.subject.O) : undefined,
    issuer: cert.issuer && (cert.issuer.CN || cert.issuer.O) ? (cert.issuer.CN || cert.issuer.O) : undefined,
    validFrom: cert.valid_from,
    validTo: cert.valid_to,
    selfSigned: isStructurallySelfSigned(cert),
  };
}

// The ONLY verification failure eligible for TOFU pinning. Everything else —
// expired certs, hostname mismatches, untrusted/misconfigured CA chains — is
// rejected strictly, so a user pin can never silently downgrade what should
// have been CA verification. SELF_SIGNED_CERT_IN_CHAIN is deliberately NOT
// eligible: it is produced for untrusted PRIVATE-CA chains (a CA-issued leaf
// below a self-signed root), and those must stay strict.
const SELF_SIGNED_AUTH_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

// Short-lived, main-process-only record of the certificate a server ACTUALLY
// presented when the last connection attempt was refused as untrusted. The
// trust IPC validates against this (never against renderer-supplied metadata)
// so a forged renderer payload cannot pin an arbitrary fingerprint.
// Key: `${host}:${port}` (host lowercased).
const TRUST_OBSERVATION_TTL_MS = 5 * 60 * 1000;
const pendingTrustObservations = new Map();

function trustObservationKey(host, port) {
  return `${String(host || '').toLowerCase()}:${port}`;
}

function recordTrustObservation(host, port, certInfo) {
  if (!certInfo || !certInfo.fingerprint) return;
  pendingTrustObservations.set(trustObservationKey(host, port), {
    certificate: certInfo,
    observedAt: Date.now(),
  });
  // Opportunistically prune expired entries so the map cannot grow unbounded.
  const now = Date.now();
  for (const [key, obs] of pendingTrustObservations) {
    if (now - obs.observedAt > TRUST_OBSERVATION_TTL_MS) pendingTrustObservations.delete(key);
  }
}

// Decide whether a completed TLS handshake may be used:
//  - CA-verified (chain + hostname check via SNI)           -> accept
//  - Self-signed + fingerprint matches persisted TOFU pin   -> accept
//  - Self-signed + pin exists but fingerprint CHANGED       -> reject (MITM)
//  - Self-signed + no pin yet                               -> reject, asking
//    the user to verify + trust the fingerprint explicitly
//  - ANY other verification failure (expired, hostname
//    mismatch, untrusted CA, invalid chain)                 -> strict reject,
//    even when a pin exists
// Returns { ok, code?, message?, certificate? }.
function evaluateCertificate(tlsSocket, host, port, storePath) {
  // Detailed form so self-signed leaves self-reference via issuerCertificate.
  const cert = tlsSocket.getPeerCertificate(true);
  const certInfo = describeCertificate(cert);

  if (tlsSocket.authorized) {
    return { ok: true, certificate: { ...certInfo, trust: 'ca' } };
  }

  const authError = tlsSocket.authorizationError || 'certificate verification failed';

  // Independent hostname identity check. Node reports a self-signed chain
  // failure (DEPTH_ZERO_SELF_SIGNED_CERT) BEFORE hostname mismatches, so
  // authorizationError alone can never surface a wrong-host certificate on
  // the TOFU path. Identity failures are strict rejections — never pinnable.
  if (cert && cert.raw) {
    const identityError = tls.checkServerIdentity(host, cert);
    if (identityError) {
      return {
        ok: false,
        code: 'CERT_INVALID',
        message:
          `The server's TLS certificate is not valid for ${host} (${identityError.message}). ` +
          'If you previously trusted this server, its certificate may have been replaced — this can mean a man-in-the-middle attack.',
        certificate: certInfo || undefined,
      };
    }
  }

  // TOFU is reserved for certificates that are PROVABLY self-signed leaves:
  // the verification failure must be the depth-zero self-signed code AND the
  // presented leaf must be structurally self-signed (self-referential issuer
  // or subject === issuer), so a crafted/private-CA chain cannot borrow the
  // self-signed failure code to become pinnable.
  const isSelfSignedFailure =
    SELF_SIGNED_AUTH_ERRORS.has(authError) && isStructurallySelfSigned(cert);

  if (!isSelfSignedFailure) {
    return {
      ok: false,
      code: 'CERT_INVALID',
      message:
        `The server's TLS certificate failed verification (${authError}) and is not a self-signed certificate, ` +
        'so it cannot be trusted manually. Fix the certificate on the server (valid chain, matching hostname, not expired). ' +
        'If you previously trusted this server, its certificate may have been replaced — this can mean a man-in-the-middle attack.',
      certificate: certInfo || undefined,
    };
  }

  if (!certInfo || !certInfo.fingerprint) {
    return {
      ok: false,
      code: 'CERT_UNTRUSTED',
      message: `The server's TLS certificate could not be verified (${authError}) and no certificate was presented to inspect.`,
    };
  }

  const pinned = storePath ? getPinnedCertificate(storePath, host, port) : null;
  if (pinned && pinned.fingerprint === certInfo.fingerprint.toUpperCase()) {
    return { ok: true, certificate: { ...certInfo, trust: 'pinned' } };
  }
  if (pinned) {
    // Record the observed (proven self-signed) leaf so a deliberate re-trust
    // after server rotation can be validated main-process-side.
    recordTrustObservation(host, port, certInfo);
    return {
      ok: false,
      code: 'CERT_FINGERPRINT_CHANGED',
      message:
        `The server's TLS certificate does NOT match the certificate you previously trusted for ${host}:${port} ` +
        `(expected ${pinned.fingerprint}, got ${certInfo.fingerprint}). ` +
        'This can mean a man-in-the-middle attack. Only re-trust if you have verified the new fingerprint with your server.',
      certificate: { ...certInfo, expectedFingerprint: pinned.fingerprint },
    };
  }
  // Record the observed (proven self-signed) leaf; the trust IPC pins ONLY a
  // fingerprint that matches this main-process observation.
  recordTrustObservation(host, port, certInfo);
  return {
    ok: false,
    code: 'CERT_UNTRUSTED',
    message:
      `The server's TLS certificate is not signed by a trusted certificate authority (${authError}). ` +
      'Self-signed certificates are common on Electrum servers — verify the fingerprint with your server before trusting it.',
    certificate: certInfo,
  };
}

// Create a fresh Electrum connection. `options` carries transport + TLS
// trust settings: { useTor, torProxyUrl, ca (test-only extra root) }.
function createElectrumConnection(host, port, useSSL, timeout = 30000, options = {}) {
  const cleanedHost = cleanElectrumHost(host);
  const transport = options.useTor ? 'tor' : 'direct';

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    (async () => {
      console.log(`[Electrum Pool] Creating new connection to ${cleanedHost}:${port} (transport: ${transport}, SSL: ${!!useSSL})`);

      let socket;
      try {
        socket = await createTcpSocket(cleanedHost, port, options, timeout);
      } catch (err) {
        fail(err);
        return;
      }

      if (!useSSL) {
        socket.electrumTransport = transport;
        resolve(socket);
        settled = true;
        return;
      }

      const tlsOptions = {
        socket,
        servername: cleanedHost,
        // Verification is performed explicitly in evaluateCertificate below
        // (CA check first, then the persisted TOFU pin). Never silently accept.
        rejectUnauthorized: false,
      };
      if (options.ca) tlsOptions.ca = options.ca;

      const tlsSocket = tls.connect(tlsOptions, () => {
        const decision = evaluateCertificate(tlsSocket, cleanedHost, port, trustStorePath);
        if (!decision.ok) {
          console.log(`[Electrum Pool] TLS rejected for ${cleanedHost}:${port}: ${decision.code} - ${decision.message}`);
          try { tlsSocket.destroy(); } catch (e) {}
          const err = new Error(decision.message);
          err.code = decision.code;
          err.certificate = decision.certificate;
          fail(err);
          return;
        }
        if (decision.certificate?.trust === 'pinned') {
          console.log(`[Electrum Pool] TLS accepted via pinned certificate for ${cleanedHost}:${port}`);
        }
        tlsSocket.electrumTransport = transport;
        tlsSocket.electrumCertificate = decision.certificate;
        settled = true;
        resolve(tlsSocket);
      });

      tlsSocket.setTimeout(timeout);
      tlsSocket.on('timeout', () => {
        tlsSocket.destroy();
        fail(new Error(`Connection timeout after ${timeout / 1000}s`));
      });
      tlsSocket.on('error', (err) => {
        fail(new Error(`Connection failed: ${err.message}`));
      });
    })();
  });
}

// The pool key must distinguish transport and TLS mode so a direct (or
// unencrypted) connection is never reused for a request that asked for Tor
// (or vice versa).
function poolKey(cleanedHost, port, useSSL, options = {}) {
  const transport = options.useTor ? `tor:${options.torProxyUrl || 'auto'}` : 'direct';
  return `${cleanedHost}:${port}:${useSSL ? 'ssl' : 'tcp'}:${transport}`;
}

// Get or create a pooled connection with multiplexed request handling
async function getPooledConnection(host, port, useSSL, timeout = 30000, options = {}) {
  const cleanedHost = cleanElectrumHost(host);
  const key = poolKey(cleanedHost, port, useSSL, options);
  
  // Check for existing healthy connection
  if (electrumPool.connections.has(key)) {
    const conn = electrumPool.connections.get(key);
    if (conn.healthy && conn.socket && !conn.socket.destroyed) {
      console.log(`[Electrum Pool] Reusing connection: ${key}`);
      conn.lastUsed = Date.now();
      return { key, pooled: true };
    } else {
      // Clean up unhealthy connection
      try { conn.socket.destroy(); } catch (e) {}
      electrumPool.connections.delete(key);
    }
  }
  
  // Create new connection
  console.log(`[Electrum Pool] Creating new connection: ${key}`);
  const socket = await createElectrumConnection(cleanedHost, port, useSSL, timeout, options);

  // Store in pool with multiplexed handler
  const conn = {
    socket,
    host: cleanedHost,
    port,
    useSSL,
    transport: socket.electrumTransport || (options.useTor ? 'tor' : 'direct'),
    certificate: socket.electrumCertificate || null,
    lastUsed: Date.now(),
    healthy: true,
    versionSent: false,
  };
  
  electrumPool.connections.set(key, conn);
  
  // Setup multiplexed data handler (handles error/close events too)
  setupMultiplexedHandler(conn, key);
  
  // Start keepalive timer if not running
  startKeepalive();
  
  return { key, pooled: false };
}

// Send server.version handshake only once per connection
async function ensureVersionHandshake(key, timeout = 15000) {
  const conn = electrumPool.connections.get(key);
  if (!conn) throw new Error('Connection not available');
  
  if (!conn.versionSent) {
    const version = await pooledRequest(key, 'server.version', ['KYUTXO', '1.4'], timeout);
    conn.versionSent = true;
    return version;
  }
  
  // Already sent version, just ping to verify connection is alive
  await pooledRequest(key, 'server.ping', [], timeout);
  return conn.cachedVersion || ['unknown', '1.4'];
}

function registerElectrumHandlers(ipcMain, { dataDir } = {}) {
  // Configure the persisted TOFU trust store. Without a dataDir there is no
  // persistence, so self-signed certs can never be trusted (fail closed).
  trustStorePath = dataDir ? certStorePath(dataDir) : null;

  // Persist (or overwrite) a user-approved certificate pin for a server.
  // SECURITY: renderer-supplied certificate metadata is NEVER trusted. The
  // pin is written only when it matches a short-lived main-process record of
  // the certificate the server actually presented during the refused
  // connection — and that record is only created for proven self-signed
  // leaves on the TOFU path.
  ipcMain.handle('electrum-trust-certificate', async (event, { host, port, certificate }) => {
    try {
      if (!host || !port || !certificate?.fingerprint) {
        return { success: false, error: 'host, port and certificate.fingerprint are required' };
      }
      if (!trustStorePath) {
        return { success: false, error: 'No certificate trust store is configured' };
      }
      const cleanedHost = cleanElectrumHost(host);
      const key = trustObservationKey(cleanedHost, port);
      const observation = pendingTrustObservations.get(key);
      if (!observation || Date.now() - observation.observedAt > TRUST_OBSERVATION_TTL_MS) {
        pendingTrustObservations.delete(key);
        return {
          success: false,
          error:
            'No recent untrusted-certificate observation for this server. Run the connection test again and trust the certificate it actually presents.',
        };
      }
      const observed = observation.certificate;
      if (observed.fingerprint.toUpperCase() !== String(certificate.fingerprint).toUpperCase()) {
        return {
          success: false,
          error:
            'The fingerprint does not match the certificate the server presented during the connection test. Re-run the test.',
        };
      }
      // observed.selfSigned is guaranteed: observations are recorded only on
      // the TOFU path after the structural self-signed check.
      const entry = trustCertificate(trustStorePath, cleanedHost, port, {
        fingerprint: observed.fingerprint,
        subject: observed.subject,
        issuer: observed.issuer,
        validFrom: observed.validFrom,
        validTo: observed.validTo,
      });
      pendingTrustObservations.delete(key);
      return { success: true, pinned: entry };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Report the currently pinned certificate (if any) for a server, so the UI
  // can show the active trust state.
  ipcMain.handle('electrum-get-certificate-trust', async (event, { host, port }) => {
    try {
      if (!host || !port) {
        return { success: false, error: 'host and port are required', pinned: null };
      }
      const cleanedHost = cleanElectrumHost(host);
      const pinned = trustStorePath ? getPinnedCertificate(trustStorePath, cleanedHost, port) : null;
      return { success: true, pinned };
    } catch (error) {
      return { success: false, error: error.message, pinned: null };
    }
  });

  // Electrum connection test (creates fresh connection to test connectivity)
  ipcMain.handle('electrum-test', async (event, { host, port, useSSL, timeout, useTor, torProxyUrl }) => {
    const startTime = Date.now();
    const cleanedHost = cleanElectrumHost(host);
    const options = { useTor: !!useTor, torProxyUrl };

    try {
      // Get or create pooled connection
      const { key, pooled } = await getPooledConnection(cleanedHost, port, useSSL, timeout || 15000, options);

      // Send server.version only on fresh connections, ping on reused ones
      const version = await ensureVersionHandshake(key, timeout || 15000);

      // Cache version for future reuse
      const conn = electrumPool.connections.get(key);
      if (conn) conn.cachedVersion = version;

      // Get block height to verify full functionality
      const headerResult = await pooledRequest(key, 'blockchain.headers.subscribe', [], timeout || 15000);
      const blockHeight = headerResult?.height || headerResult?.block_height;

      const latency = Date.now() - startTime;

      return {
        success: true,
        serverVersion: Array.isArray(version) ? version.join(' ') : String(version),
        blockHeight,
        latency,
        message: `Connected to Electrum server (${Array.isArray(version) ? version[0] : version})`,
        connectionPooled: pooled,
        transport: conn?.transport || (options.useTor ? 'tor' : 'direct'),
        certificate: conn?.certificate || undefined,
      };
    } catch (error) {
      const latency = Date.now() - startTime;
      // If test fails, destroy the pooled connection so next attempt starts fresh
      const key = poolKey(cleanedHost, port, useSSL, options);
      const conn = electrumPool.connections.get(key);
      if (conn) {
        try { conn.socket.destroy(); } catch (e) {}
        electrumPool.connections.delete(key);
      }
      return {
        success: false,
        error: error.message,
        errorCode: error.code || undefined,
        certificate: error.certificate || undefined,
        latency,
      };
    }
  });

  // Get address history (transactions) via Electrum - uses connection pool
  ipcMain.handle('electrum-get-history', async (event, { host, port, useSSL, address, timeout, useTor, torProxyUrl }) => {
    try {
      const { key } = await getPooledConnection(host, port, useSSL, timeout || 30000, { useTor: !!useTor, torProxyUrl });
      await ensureVersionHandshake(key, timeout || 15000);
      
      const scripthash = addressToScripthash(address);
      const history = await pooledRequest(key, 'blockchain.scripthash.get_history', [scripthash], timeout || 30000);
      
      return {
        success: true,
        history: history || [],
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        history: [],
      };
    }
  });

  // Get address UTXOs via Electrum - uses connection pool
  ipcMain.handle('electrum-get-utxos', async (event, { host, port, useSSL, address, timeout, useTor, torProxyUrl }) => {
    try {
      const { key } = await getPooledConnection(host, port, useSSL, timeout || 30000, { useTor: !!useTor, torProxyUrl });
      await ensureVersionHandshake(key, timeout || 15000);
      
      const scripthash = addressToScripthash(address);
      const utxos = await pooledRequest(key, 'blockchain.scripthash.listunspent', [scripthash], timeout || 30000);
      
      return {
        success: true,
        utxos: utxos || [],
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        utxos: [],
      };
    }
  });

  // Get transaction details via Electrum - uses connection pool
  ipcMain.handle('electrum-get-transaction', async (event, { host, port, useSSL, txid, verbose, timeout, useTor, torProxyUrl }) => {
    try {
      const { key } = await getPooledConnection(host, port, useSSL, timeout || 30000, { useTor: !!useTor, torProxyUrl });
      await ensureVersionHandshake(key, timeout || 15000);
      
      const tx = await pooledRequest(key, 'blockchain.transaction.get', [txid, verbose !== false], timeout || 30000);
      
      return {
        success: true,
        transaction: tx,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  });

  // Get the block hash at a given height via Electrum - uses connection pool.
  // blockchain.block.header returns the raw 80-byte header hex; the block hash
  // is the double-SHA256 of that header, byte-reversed. Computed here in Node
  // so the renderer only compares hex strings.
  ipcMain.handle('electrum-get-block-hash', async (event, { host, port, useSSL, height, timeout, useTor, torProxyUrl }) => {
    try {
      if (!Number.isInteger(height) || height < 0) {
        return { success: false, error: `Invalid block height: ${height}` };
      }
      const { key } = await getPooledConnection(host, port, useSSL, timeout || 30000, { useTor: !!useTor, torProxyUrl });
      await ensureVersionHandshake(key, timeout || 15000);

      const headerHex = await pooledRequest(key, 'blockchain.block.header', [height], timeout || 30000);
      if (typeof headerHex !== 'string' || headerHex.length < 160) {
        return { success: false, error: 'Electrum server returned an invalid block header' };
      }
      const headerBytes = Buffer.from(headerHex.slice(0, 160), 'hex');
      const hash1 = crypto.createHash('sha256').update(headerBytes).digest();
      const hash2 = crypto.createHash('sha256').update(hash1).digest();
      const blockHash = Buffer.from(hash2).reverse().toString('hex');

      return { success: true, blockHash };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  });

  // Batch get history for multiple addresses - uses connection pool with multiplexing.
  // Requests are PIPELINED over the single multiplexed socket (responses are
  // matched by request id, so overlap is safe) with a bounded in-flight
  // window. Awaiting each request one at a time made a 40-address batch cost
  // ~40 sequential round-trips; the window bounds the burst at the same
  // concurrency the renderer already uses for per-address balance lookups,
  // so public servers see no harder load than the existing phases.
  const BATCH_PIPELINE_WINDOW = 8;

  ipcMain.handle('electrum-batch-get-history', async (event, { host, port, useSSL, addresses, timeout, useTor, torProxyUrl }) => {
    const startTime = Date.now();

    try {
      const { key, pooled } = await getPooledConnection(host, port, useSSL, timeout || 60000, { useTor: !!useTor, torProxyUrl });
      await ensureVersionHandshake(key, timeout || 15000);

      console.log(`[Electrum Pool] Batch fetching ${addresses.length} addresses (connection ${pooled ? 'reused' : 'new'}, window ${BATCH_PIPELINE_WINDOW})`);

      // Indexed by input position so result order matches the request order
      // even though responses arrive out of order. Per-address failures stay
      // isolated: one bad address only fails its own entry.
      const results = new Array(addresses.length);
      let next = 0;
      const pipelineWorker = async () => {
        while (true) {
          const i = next++;
          if (i >= addresses.length) return;
          const address = addresses[i];
          try {
            const scripthash = addressToScripthash(address);
            const history = await pooledRequest(key, 'blockchain.scripthash.get_history', [scripthash], timeout || 30000);
            results[i] = {
              address,
              success: true,
              history: history || [],
            };
          } catch (err) {
            results[i] = {
              address,
              success: false,
              error: err.message,
              history: [],
            };
          }
        }
      };
      const workers = [];
      for (let w = 0; w < Math.min(BATCH_PIPELINE_WINDOW, addresses.length); w++) {
        workers.push(pipelineWorker());
      }
      await Promise.all(workers);
      
      const latency = Date.now() - startTime;
      
      return {
        success: true,
        results,
        latency,
        addressCount: addresses.length,
        connectionReused: pooled,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        results: [],
        latency: Date.now() - startTime,
      };
    }
  });

  // Batch get UTXOs (balances) for multiple addresses — mirrors
  // electrum-batch-get-history: requests are pipelined over the single
  // multiplexed socket with the same bounded in-flight window, results are
  // indexed by input position, and per-address failures stay isolated so one
  // bad address only fails its own entry.
  ipcMain.handle('electrum-batch-get-utxos', async (event, { host, port, useSSL, addresses, timeout, useTor, torProxyUrl }) => {
    const startTime = Date.now();

    try {
      const { key, pooled } = await getPooledConnection(host, port, useSSL, timeout || 60000, { useTor: !!useTor, torProxyUrl });
      await ensureVersionHandshake(key, timeout || 15000);

      console.log(`[Electrum Pool] Batch fetching UTXOs for ${addresses.length} addresses (connection ${pooled ? 'reused' : 'new'}, window ${BATCH_PIPELINE_WINDOW})`);

      const results = new Array(addresses.length);
      let next = 0;
      const pipelineWorker = async () => {
        while (true) {
          const i = next++;
          if (i >= addresses.length) return;
          const address = addresses[i];
          try {
            const scripthash = addressToScripthash(address);
            const utxos = await pooledRequest(key, 'blockchain.scripthash.listunspent', [scripthash], timeout || 30000);
            results[i] = {
              address,
              success: true,
              utxos: utxos || [],
            };
          } catch (err) {
            results[i] = {
              address,
              success: false,
              error: err.message,
              utxos: [],
            };
          }
        }
      };
      const workers = [];
      for (let w = 0; w < Math.min(BATCH_PIPELINE_WINDOW, addresses.length); w++) {
        workers.push(pipelineWorker());
      }
      await Promise.all(workers);

      const latency = Date.now() - startTime;

      return {
        success: true,
        results,
        latency,
        addressCount: addresses.length,
        connectionReused: pooled,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        results: [],
        latency: Date.now() - startTime,
      };
    }
  });
}

module.exports = {
  registerElectrumHandlers,
  stopKeepalive,
  // Exported for Node-level tests only (TLS trust decisions, pool keying,
  // and direct connection creation without going through IPC).
  _test: {
    electrumPool,
    poolKey,
    evaluateCertificate,
    createElectrumConnection,
    cleanElectrumHost,
    getTrustStorePath: () => trustStorePath,
  },
};
