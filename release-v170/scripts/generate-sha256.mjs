#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = '[release-checksums]';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function sha256File(filePath) {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function findExecutables(inputs) {
  const files = [];
  for (const input of inputs) {
    const resolved = path.resolve(ROOT, input);
    if (!fs.existsSync(resolved)) {
      throw new Error(`${TAG} input does not exist: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(resolved).sort()) {
        const candidate = path.join(resolved, name);
        if (/\.exe$/i.test(name) && fs.statSync(candidate).isFile()) files.push(candidate);
      }
    } else if (stat.isFile() && /\.exe$/i.test(resolved)) {
      files.push(resolved);
    } else {
      throw new Error(`${TAG} expected an .exe file or directory: ${resolved}`);
    }
  }
  return [...new Set(files)];
}

export function writeChecksums(inputs) {
  const executables = findExecutables(inputs);
  if (executables.length === 0) {
    throw new Error(`${TAG} no .exe release assets found`);
  }
  return executables.map((executable) => {
    const digest = sha256File(executable);
    const checksumPath = `${executable}.sha256`;
    fs.writeFileSync(checksumPath, `${digest}  ${path.basename(executable)}\n`, 'utf8');
    return { executable, checksumPath, digest };
  });
}

export function verifyChecksums(inputs) {
  const executables = findExecutables(inputs);
  if (executables.length === 0) {
    throw new Error(`${TAG} no .exe release assets found`);
  }

  const directories = new Set(executables.map((executable) => path.dirname(executable)));
  const sidecars = [];
  for (const directory of directories) {
    for (const name of fs.readdirSync(directory).sort()) {
      const candidate = path.join(directory, name);
      if (/\.exe\.sha256$/i.test(name) && fs.statSync(candidate).isFile()) {
        sidecars.push(candidate);
      }
    }
  }

  const expectedSidecars = new Set(executables.map((executable) => `${executable}.sha256`));
  for (const sidecar of sidecars) {
    if (!expectedSidecars.has(sidecar)) {
      throw new Error(`${TAG} duplicate or unmatched SHA-256 sidecar: ${sidecar}`);
    }
  }

  return executables.map((executable) => {
    const checksumPath = `${executable}.sha256`;
    if (!fs.existsSync(checksumPath)) {
      throw new Error(`${TAG} missing SHA-256 sidecar for ${path.basename(executable)}`);
    }

    const text = fs.readFileSync(checksumPath, 'utf8');
    const match = /^([a-f0-9]{64})  ([^\r\n/\\]+)\r?\n?$/i.exec(text);
    if (!match) {
      throw new Error(`${TAG} malformed SHA-256 sidecar: ${checksumPath}`);
    }
    if (match[2] !== path.basename(executable)) {
      throw new Error(
        `${TAG} SHA-256 sidecar filename mismatch for ${path.basename(executable)}: ${match[2]}`,
      );
    }

    const expectedDigest = match[1].toLowerCase();
    const actualDigest = sha256File(executable);
    if (actualDigest !== expectedDigest) {
      throw new Error(
        `${TAG} SHA-256 mismatch for ${path.basename(executable)}: ` +
        `expected ${expectedDigest}, got ${actualDigest}`,
      );
    }
    return { executable, checksumPath, digest: actualDigest };
  });
}

function main() {
  const args = process.argv.slice(2);
  const verify = args[0] === '--verify';
  const inputs = verify ? args.slice(1) : args;
  if (inputs.length === 0) {
    throw new Error(
      `Usage: node scripts/generate-sha256.mjs [--verify] <exe-or-directory> [...]`,
    );
  }
  for (const result of verify ? verifyChecksums(inputs) : writeChecksums(inputs)) {
    console.log(
      `${TAG} ${verify ? 'verified ' : ''}${path.relative(ROOT, result.checksumPath)} -> ${result.digest}`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`${TAG} FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}