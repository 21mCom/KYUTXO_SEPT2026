import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROVENANCE_FILENAME = 'verified-package-provenance.json';

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function filesInTree(dir, root = dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesInTree(full, root));
    else if (entry.isFile()) files.push(path.relative(root, full).replaceAll(path.sep, '/'));
  }
  return files.sort();
}

function sha256Tree(dir) {
  const hash = crypto.createHash('sha256');
  for (const relative of filesInTree(dir)) {
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(dir, relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function packagePaths(root) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  return {
    renderer: path.join(root, 'dist', 'public'),
    asar: path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar'),
    executable: path.join(root, 'release', `KYUTXO-${version}-Portable.exe`),
  };
}

export function writePackagedBuildProvenance({ root = ROOT, revision }) {
  if (!revision) throw new Error('A source revision is required to create packaged provenance');
  const paths = packagePaths(root);
  for (const [kind, filePath] of Object.entries(paths)) {
    if (!fs.existsSync(filePath)) throw new Error(`Cannot record ${kind} provenance; missing ${filePath}`);
  }
  const provenance = {
    schemaVersion: 1,
    sourceRevision: revision,
    rendererSha256: sha256Tree(paths.renderer),
    asarSha256: sha256File(paths.asar),
    executableSha256: sha256File(paths.executable),
  };
  const outputPath = path.join(root, 'release', PROVENANCE_FILENAME);
  fs.writeFileSync(outputPath, `${JSON.stringify(provenance, null, 2)}\n`);
  return { outputPath, provenance };
}

export function verifyPackagedBuildProvenance({
  root = ROOT,
  provenancePath = path.join(root, 'release', PROVENANCE_FILENAME),
  expectedRevision,
  scope = 'all',
}) {
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  if (provenance.schemaVersion !== 1) throw new Error('Unsupported packaged provenance schema');
  if (expectedRevision && provenance.sourceRevision !== expectedRevision) {
    throw new Error(
      `Packaged provenance revision mismatch: expected ${expectedRevision}, found ${provenance.sourceRevision}`,
    );
  }
  const paths = packagePaths(root);
  const checks = {
    renderer: () => sha256Tree(paths.renderer),
    asar: () => sha256File(paths.asar),
    executable: () => sha256File(paths.executable),
  };
  const expected = {
    renderer: provenance.rendererSha256,
    asar: provenance.asarSha256,
    executable: provenance.executableSha256,
  };
  const kinds = scope === 'renderer' ? ['renderer'] : scope === 'asar' ? ['renderer', 'asar'] : Object.keys(checks);
  for (const kind of kinds) {
    const actual = checks[kind]();
    if (actual !== expected[kind]) {
      throw new Error(`Downloaded packaged ${kind} bytes do not match verified provenance`);
    }
  }
  return provenance;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const verify = process.argv.includes('--verify');
    const expectedRevision = process.env.GITHUB_SHA ||
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 30_000,
      }).trim();
    if (verify) {
      verifyPackagedBuildProvenance({ expectedRevision });
      console.log(`[packaged-provenance] verified package bytes for ${expectedRevision}`);
    } else {
      const { outputPath } = writePackagedBuildProvenance({ revision: expectedRevision });
      console.log(`[packaged-provenance] wrote ${path.relative(ROOT, outputPath)}`);
    }
  } catch (error) {
    console.error(`[packaged-provenance] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}