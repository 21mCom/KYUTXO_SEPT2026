const path = require('path');
const fs = require('fs');

// Single source of truth for where KYUTXO keeps its on-disk data. Both the
// Electron main process (at startup) and the integration tests resolve their
// directories through here so a regression in the layout (e.g. the Needs Review
// folder moving away from the attachments dir) is caught by the test suite
// instead of silently shipping.
//
// In portable mode `baseDir` is the portable executable directory and the data
// lives under `KYUTXO_Data`; in standard mode `baseDir` is Electron's userData
// path and the data lives under `data`.
function resolveDataDirs({ baseDir, portableMode }) {
  const dataDir = portableMode
    ? path.join(baseDir, 'KYUTXO_Data')
    : path.join(baseDir, 'data');
  const attachmentsDir = path.join(dataDir, 'attachments');
  const needsReviewDir = path.join(dataDir, 'attachments-needs-review');
  return { dataDir, attachmentsDir, needsReviewDir };
}

// Create the data, attachments, and Needs Review directories if they are
// missing. Safe to call on every launch — existing folders (and the files in
// them) are left untouched, which is what lets Needs Review survive a restart.
function ensureDirectories({ dataDir, attachmentsDir, needsReviewDir }) {
  for (const dir of [dataDir, attachmentsDir, needsReviewDir]) {
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

module.exports = { resolveDataDirs, ensureDirectories };
