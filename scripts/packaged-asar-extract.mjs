import fs from 'node:fs';
import path from 'node:path';

function entrySegments(entry) {
  const normalized = entry.replaceAll('\\', '/').replace(/^\/+/, '');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`unsafe asar entry path: ${entry}`);
  }
  return segments;
}

export function extractAvailableAsarTree({ asar, archivePath, destination, onMissingUnpacked }) {
  const destinationRoot = path.resolve(destination);
  fs.mkdirSync(destinationRoot, { recursive: true });

  for (const entry of asar.listPackage(archivePath)) {
    const segments = entrySegments(entry);
    if (segments.length === 0) continue;

    const relativePath = segments.join('/');
    const targetPath = path.join(destinationRoot, ...segments);
    const info = asar.statFile(archivePath, relativePath, false);

    if (info.files) {
      fs.mkdirSync(targetPath, { recursive: true });
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (info.unpacked) {
      const unpackedPath = path.join(`${archivePath}.unpacked`, ...segments);
      if (!fs.existsSync(unpackedPath)) {
        onMissingUnpacked?.(relativePath);
        continue;
      }
      fs.copyFileSync(unpackedPath, targetPath);
      continue;
    }

    fs.writeFileSync(targetPath, asar.extractFile(archivePath, relativePath));
  }
}