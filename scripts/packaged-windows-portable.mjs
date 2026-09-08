import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PORTABLE_NAME_PATTERN = /^KYUTXO-.+-Portable\.exe$/i;
const MTIME_TOLERANCE_MS = 1_000;

function sha256(filePath, fileSystem = fs) {
  return crypto.createHash('sha256').update(fileSystem.readFileSync(filePath)).digest('hex');
}

function walkFiles(root, fileSystem = fs) {
  const files = [];
  for (const entry of fileSystem.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(entryPath, fileSystem));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function run7ZipExtract(archivePath, outputDir) {
  const result = spawnSync('7z', ['x', '-y', `-o${outputDir}`, archivePath], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5 * 60_000,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim();
    throw new Error(`7-Zip could not extract ${archivePath}: ${detail || `exit ${result.status}`}`);
  }
}

export function verifyWindowsPortableBundle({
  artifactPath,
  asarPath,
  tag = '[packaged-windows-portable]',
  fileSystem = fs,
  makeTempDir = (prefix) => fileSystem.mkdtempSync(prefix),
  extractArchive = run7ZipExtract,
}) {
  const tempRoot = makeTempDir(path.join(os.tmpdir(), 'kyutxo-portable-verify-'));
  try {
    const outerDir = path.join(tempRoot, 'outer');
    fileSystem.mkdirSync(outerDir, { recursive: true });
    extractArchive(artifactPath, outerDir);

    const embeddedArchives = walkFiles(outerDir, fileSystem)
      .filter((filePath) => /\.(?:7z|zip)$/i.test(filePath))
      .sort();
    if (embeddedArchives.length === 0) {
      throw new Error('portable wrapper contains no embedded app archive');
    }

    const appDir = path.join(tempRoot, 'app');
    fileSystem.mkdirSync(appDir, { recursive: true });
    for (const archivePath of embeddedArchives) extractArchive(archivePath, appDir);

    const embeddedAsars = walkFiles(appDir, fileSystem)
      .filter((filePath) =>
        path.basename(filePath).toLowerCase() === 'app.asar' &&
        path.basename(path.dirname(filePath)).toLowerCase() === 'resources',
      )
      .sort();
    if (embeddedAsars.length !== 1) {
      throw new Error(
        `portable wrapper must contain exactly one resources/app.asar; found ${embeddedAsars.length}`,
      );
    }

    const validatedDigest = sha256(asarPath, fileSystem);
    const embeddedDigest = sha256(embeddedAsars[0], fileSystem);
    if (embeddedDigest !== validatedDigest) {
      throw new Error(
        `embedded app.asar SHA-256 ${embeddedDigest} does not match validated app.asar ` +
          `${validatedDigest}; rebuild Portable.exe from the validated package`,
      );
    }
    return { validatedDigest, embeddedDigest };
  } catch (error) {
    throw new Error(`${tag} portable bundle integrity check failed: ${error.message}`);
  } finally {
    fileSystem.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function findWindowsPortableArtifact({
  root,
  asarPath,
  tag = '[packaged-windows-portable]',
  fileSystem = fs,
  verifyBundle = verifyWindowsPortableBundle,
}) {
  let version;
  try {
    version = JSON.parse(
      fileSystem.readFileSync(path.join(root, 'package.json'), 'utf8'),
    ).version;
  } catch (error) {
    throw new Error(`${tag} could not read package version for portable artifact: ${error.message}`);
  }

  const releaseDir = path.join(root, 'release');
  const expected = path.join(releaseDir, `KYUTXO-${version}-Portable.exe`);
  let portableStat;
  try {
    portableStat = fileSystem.statSync(expected);
  } catch {
    portableStat = null;
  }

  if (!portableStat?.isFile() || portableStat.size <= 0) {
    let candidates = [];
    try {
      candidates = fileSystem.readdirSync(releaseDir).filter((name) =>
        PORTABLE_NAME_PATTERN.test(name),
      );
    } catch {
      // Report the actionable expected path below.
    }
    throw new Error(
      `${tag} generated portable artifact is missing or empty: ${expected}; ` +
        `portable candidates found: ${candidates.join(', ') || 'none'}`,
    );
  }

  let asarStat;
  try {
    asarStat = fileSystem.statSync(asarPath);
  } catch {
    throw new Error(`${tag} validated app.asar is missing: ${asarPath}`);
  }
  if (portableStat.mtimeMs + MTIME_TOLERANCE_MS < asarStat.mtimeMs) {
    throw new Error(`${tag} portable artifact predates the validated app.asar: ${expected}`);
  }
  const evidence = verifyBundle({ artifactPath: expected, asarPath, tag, fileSystem });
  if (evidence?.validatedDigest) {
    console.log(
      `${tag} verified Portable.exe embeds validated app.asar SHA-256 ` +
        evidence.validatedDigest,
    );
  }
  return expected;
}

export function prepareWindowsPortableLaunch({
  root,
  asarPath,
  home,
  tag,
  env = process.env,
  fileSystem = fs,
  verifyBundle = verifyWindowsPortableBundle,
}) {
  const artifactPath = findWindowsPortableArtifact({
    root,
    asarPath,
    tag,
    fileSystem,
    verifyBundle,
  });
  const launchDir = path.join(home, 'portable-launch');
  const tempDir = path.join(home, 'temp');
  fileSystem.mkdirSync(launchDir, { recursive: true });
  fileSystem.mkdirSync(tempDir, { recursive: true });
  const executable = path.join(launchDir, path.basename(artifactPath));
  fileSystem.copyFileSync(artifactPath, executable);

  const inheritedEnv = { ...env };
  delete inheritedEnv.PORTABLE_EXECUTABLE_DIR;
  return {
    artifactPath,
    executable,
    launchDir,
    tempDir,
    env: {
      ...inheritedEnv,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      TEMP: tempDir,
      TMP: tempDir,
    },
  };
}