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

export function extractAvailableAsarTree({ asar, archivePath, destination, onMissingEntry }) {
  const destinationRoot = path.resolve(destination);
  fs.mkdirSync(destinationRoot, { recursive: true });

  const entries = asar.listPackage(archivePath).map((entry) => ({
    entry,
    segments: entrySegments(entry),
  }));
  const directoryPaths = new Set();
  for (const { segments } of entries) {
    for (let length = 1; length < segments.length; length += 1) {
      directoryPaths.add(segments.slice(0, length).join('/'));
    }
  }

  for (const { entry, segments } of entries) {
    if (segments.length === 0) continue;

    const relativePath = segments.join('/');
    const archiveEntryPath = path.join(...segments);
    const targetPath = path.join(destinationRoot, ...segments);

    if (directoryPaths.has(relativePath)) {
      fs.mkdirSync(targetPath, { recursive: true });
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    let contents;
    try {
      contents = asar.extractFile(archivePath, archiveEntryPath);
    } catch (error) {
      if (error?.code === 'ENOENT' || /was not found in this archive/.test(error?.message ?? '')) {
        onMissingEntry?.(relativePath, error);
        continue;
      }
      throw error;
    }
    fs.writeFileSync(targetPath, contents);
  }
}