import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { getPackagedTarget } from './packaged-targets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function expectedArtifactName(platform, arch, version) {
  getPackagedTarget(platform, arch);
  if (platform === 'win') return `KYUTXO-${version}-Portable.exe`;
  const extension = platform === 'darwin' ? 'dmg' : 'AppImage';
  return `KYUTXO-${version}-${arch}.${extension}`;
}

export function expectedArtifactNames(platform, arch, version) {
  if (platform === 'darwin') {
    return [`KYUTXO-${version}-${arch}.dmg`, `KYUTXO-${version}-${arch}.zip`];
  }
  return [expectedArtifactName(platform, arch, version)];
}

export function assertVersionAgreement({
  packageVersion,
  artifactPath,
  internalVersion,
  platform,
  arch,
  expectedName = expectedArtifactName(platform, arch, packageVersion),
}) {
  const actualName = path.basename(artifactPath);
  if (actualName !== expectedName) {
    throw new Error(
      `Package filename version mismatch: expected ${expectedName} from package.json, found ${actualName}`,
    );
  }
  if (internalVersion !== packageVersion) {
    throw new Error(
      `Internal app version mismatch in ${actualName}: package metadata reports ` +
        `${JSON.stringify(internalVersion)}, package.json reports ${JSON.stringify(packageVersion)}`,
    );
  }
}

function readWindowsVersion(artifactPath, exec = execFileSync) {
  const escaped = artifactPath.replaceAll("'", "''");
  return exec(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`],
    { encoding: 'utf8' },
  ).trim();
}

function readMacVersion(artifactPath, exec = execFileSync) {
  if (path.extname(artifactPath) === '.zip') {
    const entries = exec('unzip', ['-Z1', artifactPath], { encoding: 'utf8' }).split(/\r?\n/);
    const plistEntry = entries.find((entry) => /^[^/]+\.app\/Contents\/Info\.plist$/.test(entry));
    if (!plistEntry) throw new Error(`No .app Info.plist found in ${path.basename(artifactPath)}`);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-version-zip-'));
    const plistPath = path.join(tempDir, 'Info.plist');
    try {
      fs.writeFileSync(plistPath, exec('unzip', ['-p', artifactPath, plistEntry]));
      return exec(
        'plutil',
        ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plistPath],
        { encoding: 'utf8' },
      ).trim();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-version-dmg-'));
  let mounted = false;
  try {
    exec('hdiutil', ['attach', artifactPath, '-readonly', '-nobrowse', '-mountpoint', mountPoint], {
      encoding: 'utf8',
    });
    mounted = true;
    const app = fs.readdirSync(mountPoint).find((name) => name.endsWith('.app'));
    if (!app) throw new Error(`No .app bundle found in ${path.basename(artifactPath)}`);
    const plist = path.join(mountPoint, app, 'Contents', 'Info.plist');
    return exec('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], {
      encoding: 'utf8',
    }).trim();
  } finally {
    try {
      if (mounted) exec('hdiutil', ['detach', mountPoint], { encoding: 'utf8' });
    } finally {
      fs.rmSync(mountPoint, { recursive: true, force: true });
    }
  }
}

export function parseAppImageDesktopVersion(contents) {
  const match = contents.match(/^X-AppImage-Version=(.+)$/m);
  if (!match) throw new Error('Extracted AppImage desktop metadata has no X-AppImage-Version');
  return match[1].trim();
}

function readLinuxVersion(artifactPath, exec = execFileSync) {
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-version-appimage-'));
  try {
    fs.chmodSync(artifactPath, 0o755);
    exec(artifactPath, ['--appimage-extract', '*.desktop'], {
      cwd: extractDir,
      encoding: 'utf8',
      env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' },
    });
    const desktopDir = path.join(extractDir, 'squashfs-root');
    const desktop = fs.readdirSync(desktopDir).find((name) => name.endsWith('.desktop'));
    if (!desktop) throw new Error(`No desktop metadata found in ${path.basename(artifactPath)}`);
    return parseAppImageDesktopVersion(fs.readFileSync(path.join(desktopDir, desktop), 'utf8'));
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

export function inspectInternalVersion(platform, artifactPath, exec = execFileSync) {
  if (platform === 'win') return readWindowsVersion(artifactPath, exec);
  if (platform === 'darwin') return readMacVersion(artifactPath, exec);
  if (platform === 'linux') return readLinuxVersion(artifactPath, exec);
  throw new Error(`Unsupported platform ${platform}`);
}

export function verifyPackagedAppVersion({ root = ROOT, platform, arch, exec = execFileSync }) {
  const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const results = [];
  for (const expectedName of expectedArtifactNames(platform, arch, packageVersion)) {
    const artifactPath = path.join(root, 'release', expectedName);
    if (!fs.existsSync(artifactPath)) {
      throw new Error(`Expected release artifact not found: ${artifactPath}`);
    }
    const internalVersion = inspectInternalVersion(platform, artifactPath, exec);
    assertVersionAgreement({
      packageVersion,
      artifactPath,
      internalVersion,
      platform,
      arch,
      expectedName,
    });
    results.push({ artifactPath, packageVersion, internalVersion });
  }
  return results;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  return { platform: values.get('--platform'), arch: values.get('--arch') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { platform, arch } = parseArgs(process.argv.slice(2));
    if (!platform || !arch) throw new Error('Usage: --platform <win|darwin|linux> --arch <x64|arm64>');
    const results = verifyPackagedAppVersion({ platform, arch });
    for (const result of results) {
      console.log(
        `[packaged-version] verified ${path.basename(result.artifactPath)} internal version ` +
          `${result.internalVersion} matches package.json`,
      );
    }
  } catch (error) {
    console.error(`[packaged-version] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}