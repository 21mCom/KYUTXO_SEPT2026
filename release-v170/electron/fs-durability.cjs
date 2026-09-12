'use strict';

const fsp = require('node:fs/promises');

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  'EINVAL',
  'ENOTSUP',
  'EPERM',
  'EISDIR',
]);

async function syncDirectory(directory, { open = fsp.open } = {}) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
    return true;
  } catch (error) {
    if (!error || !UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error.code)) throw error;
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

module.exports = { syncDirectory };