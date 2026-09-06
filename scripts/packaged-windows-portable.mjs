import fs from 'node:fs';
import path from 'node:path';

const PORTABLE_NAME_PATTERN = /^KYUTXO-.+-Portable\.exe$/i;
const MTIME_TOLERANCE_MS = 1_000;

export function findWindowsPortableArtifact({
  root,
  asarPath,
  tag = '[packaged-windows-portable]',
  fileSystem = fs,
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
  return expected;
}

export function prepareWindowsPortableLaunch({
  root,
  asarPath,
  home,
  tag,
  env = process.env,
  fileSystem = fs,
}) {
  const artifactPath = findWindowsPortableArtifact({
    root,
    asarPath,
    tag,
    fileSystem,
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