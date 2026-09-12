// Supported desktop package targets are deliberately explicit.  A packaged
// native module is only evidence for the platform/architecture it was rebuilt
// for; never infer a release target from the host that happened to run a
// diagnostic.

export const SUPPORTED_PACKAGED_TARGETS = Object.freeze([
  Object.freeze({ platform: 'win', arch: 'x64', runner: 'windows-2022' }),
  Object.freeze({ platform: 'darwin', arch: 'x64', runner: 'macos-15-intel' }),
  Object.freeze({ platform: 'darwin', arch: 'arm64', runner: 'macos-14' }),
  Object.freeze({ platform: 'linux', arch: 'x64', runner: 'ubuntu-22.04' }),
  Object.freeze({ platform: 'linux', arch: 'arm64', runner: 'ubuntu-24.04-arm' }),
]);

const PLATFORM_FLAGS = Object.freeze({
  win: '--win',
  darwin: '--mac',
  linux: '--linux',
});

function targetKey(platform, arch) {
  return `${platform}/${arch}`;
}

export function getPackagedTarget(platform, arch) {
  const target = SUPPORTED_PACKAGED_TARGETS.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
  if (!target) {
    const supported = SUPPORTED_PACKAGED_TARGETS
      .map((candidate) => targetKey(candidate.platform, candidate.arch))
      .join(', ');
    throw new Error(
      `Unsupported packaged target ${targetKey(platform, arch)}. ` +
        `Supported targets: ${supported}`,
    );
  }
  return target;
}

export function electronBuilderTargetArgs(platform, arch) {
  getPackagedTarget(platform, arch);
  return [PLATFORM_FLAGS[platform], `--${arch}`];
}

export function expectedUnpackedDirectory(root, platform, arch) {
  getPackagedTarget(platform, arch);
  const name = platform === 'darwin'
    ? arch === 'arm64' ? 'mac-arm64' : 'mac'
    : arch === 'arm64' ? `${platform}-arm64-unpacked` : `${platform}-unpacked`;
  return `${root}/release/${name}`;
}

export function parsePackagedTargetArgs(argv = process.argv.slice(2)) {
  const values = new Map();
  let requireElectron = false;
  let localDiagnostic = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const equalIndex = value.indexOf('=');
    const key = value.slice(2, equalIndex === -1 ? undefined : equalIndex);
    const inlineValue = equalIndex === -1 ? undefined : value.slice(equalIndex + 1);
    if (key === 'help') return { help: true };
    if (key === 'require-electron') {
      requireElectron = true;
      continue;
    }
    if (key === 'local-diagnostic') {
      localDiagnostic = true;
      continue;
    }
    const next = inlineValue ?? argv[index + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    values.set(key, next);
    if (inlineValue === undefined) index += 1;
  }

  const platform = values.get('platform');
  const arch = values.get('arch');
  if (localDiagnostic && (platform || arch || requireElectron)) {
    throw new Error(
      '--local-diagnostic cannot be combined with --platform, --arch, or --require-electron',
    );
  }
  if (!localDiagnostic && (!platform || !arch)) {
    throw new Error('--platform and --arch are required');
  }
  if (!localDiagnostic) getPackagedTarget(platform, arch);
  return {
    platform,
    arch,
    unpackedDir: values.get('unpacked-dir'),
    requireElectron,
    localDiagnostic,
  };
}

export function packagedTargetHelp() {
  return [
    'Usage: node scripts/check-packaged-native-engine.mjs',
    '  --platform <win|darwin|linux> --arch <x64|arm64>',
    '  [--unpacked-dir <path>]',
    '  [--require-electron]',
    'Local non-release diagnostic: --local-diagnostic',
  ].join('\n');
}