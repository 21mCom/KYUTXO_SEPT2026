const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');

bitcoin.initEccLib(ecc);

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
      // Timeout indicates connection problems - mark unhealthy and close
      console.log(`[Electrum Pool] Request timeout on ${key}, marking connection unhealthy`);
      conn.healthy = false;
      try { conn.socket.destroy(); } catch (e) {}
      electrumPool.connections.delete(key);
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

// Create a fresh Electrum connection
function createElectrumConnection(host, port, useSSL, timeout = 30000) {
  const cleanedHost = cleanElectrumHost(host);
  
  return new Promise((resolve, reject) => {
    let socket;
    const connectOptions = { host: cleanedHost, port };
    
    console.log(`[Electrum Pool] Creating new connection to ${cleanedHost}:${port}`);
    
    if (useSSL) {
      socket = tls.connect({ ...connectOptions, rejectUnauthorized: false }, () => {
        if (!socket.authorized) {
          console.log('[Electrum Pool] TLS warning (self-signed cert accepted):', socket.authorizationError);
        }
        resolve(socket);
      });
    } else {
      socket = net.createConnection(connectOptions, () => {
        resolve(socket);
      });
    }
    
    socket.setTimeout(timeout);
    
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`Connection timeout after ${timeout/1000}s`));
    });
    
    socket.on('error', (err) => {
      reject(new Error(`Connection failed: ${err.message}`));
    });
  });
}

// Get or create a pooled connection with multiplexed request handling
async function getPooledConnection(host, port, useSSL, timeout = 30000) {
  const cleanedHost = cleanElectrumHost(host);
  const key = `${cleanedHost}:${port}`;
  
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
  const socket = await createElectrumConnection(cleanedHost, port, useSSL, timeout);
  
  // Store in pool with multiplexed handler
  const conn = {
    socket,
    host: cleanedHost,
    port,
    useSSL,
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

function registerElectrumHandlers(ipcMain) {
  // Electrum connection test (creates fresh connection to test connectivity)
  ipcMain.handle('electrum-test', async (event, { host, port, useSSL, timeout }) => {
    const startTime = Date.now();
    const cleanedHost = cleanElectrumHost(host);
    
    try {
      // Get or create pooled connection
      const { key, pooled } = await getPooledConnection(cleanedHost, port, useSSL, timeout || 15000);
      
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
      };
    } catch (error) {
      const latency = Date.now() - startTime;
      // If test fails, destroy the pooled connection so next attempt starts fresh
      const key = `${cleanedHost}:${port}`;
      const conn = electrumPool.connections.get(key);
      if (conn) {
        try { conn.socket.destroy(); } catch (e) {}
        electrumPool.connections.delete(key);
      }
      return {
        success: false,
        error: error.message,
        latency,
      };
    }
  });

  // Get address history (transactions) via Electrum - uses connection pool
  ipcMain.handle('electrum-get-history', async (event, { host, port, useSSL, address, timeout }) => {
    try {
      const { key } = await getPooledConnection(host, port, useSSL, timeout || 30000);
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
  ipcMain.handle('electrum-get-utxos', async (event, { host, port, useSSL, address, timeout }) => {
    try {
      const { key } = await getPooledConnection(host, port, useSSL, timeout || 30000);
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
  ipcMain.handle('electrum-get-transaction', async (event, { host, port, useSSL, txid, verbose, timeout }) => {
    try {
      const { key } = await getPooledConnection(host, port, useSSL, timeout || 30000);
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
  ipcMain.handle('electrum-get-block-hash', async (event, { host, port, useSSL, height, timeout }) => {
    try {
      if (!Number.isInteger(height) || height < 0) {
        return { success: false, error: `Invalid block height: ${height}` };
      }
      const { key } = await getPooledConnection(host, port, useSSL, timeout || 30000);
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

  ipcMain.handle('electrum-batch-get-history', async (event, { host, port, useSSL, addresses, timeout }) => {
    const startTime = Date.now();

    try {
      const { key, pooled } = await getPooledConnection(host, port, useSSL, timeout || 60000);
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
}

module.exports = { registerElectrumHandlers, stopKeepalive };
