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

function main() {
  const inputs = process.argv.slice(2);
  if (inputs.length === 0) {
    throw new Error(`Usage: node scripts/generate-sha256.mjs <exe-or-directory> [...]`);
  }
  for (const result of writeChecksums(inputs)) {
    console.log(
      `${TAG} ${path.relative(ROOT, result.checksumPath)} -> ${result.digest}`,
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