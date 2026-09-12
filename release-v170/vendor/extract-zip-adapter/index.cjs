'use strict';

module.exports = async function extractZip(zipPath, options) {
  const { extract } = await import('@electron-internal/extract-zip');
  return extract(zipPath, options);
};