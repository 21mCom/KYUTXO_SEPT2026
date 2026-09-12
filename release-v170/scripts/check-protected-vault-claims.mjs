#!/usr/bin/env node
// Negative release guard for built-in at-rest protection.
//
// The current product intentionally has no SQLCipher primary store or encrypted
// attachment implementation.  This guard makes that state explicit and fails
// if a future change starts claiming protection before the complete packaged
// verification suite exists.  It is intentionally separate from the native
// read-engine check: an unencrypted read replica is not a protected vault.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRootFromModuleUrl } from './packaged-bundle-freshness.mjs';

const ROOT = repoRootFromModuleUrl(import.meta.url);
const TAG = '[protected-vault-claims]';

const files = {
  design: path.join(ROOT, 'at-rest-encryption-design.md'),
  project: path.join(ROOT, 'replit.md'),
  threatModel: path.join(ROOT, 'threat_model.md'),
};

function read(name) {
  try {
    return fs.readFileSync(files[name], 'utf8');
  } catch (error) {
    throw new Error(`${TAG} required ${name} source is unreadable: ${error.message}`);
  }
}

export function checkProtectedVaultClaims(contents = Object.fromEntries(
  [
    ...Object.keys(files).map((name) => [name, read(name)]),
    ['uiSources', readUserFacingSources()],
  ],
)) {
  const results = [];
  const design = contents.design;
  const project = contents.project;
  const threatModel = contents.threatModel;
  const uiSources = contents.uiSources;

  const designStillContract = /not an implementation/i.test(design) &&
    /current application still uses plaintext/i.test(design);
  results.push({
    name: 'at-rest design remains an unimplemented contract',
    passed: designStillContract,
  });

  const plaintextWarning = /does not encrypt\s+vault data(?: stored)? on disk/i;
  results.push({
    name: 'project documentation keeps the plaintext-at-rest warning',
    passed: /stored as plaintext/i.test(project) && plaintextWarning.test(uiSources),
  });

  results.push({
    name: 'threat model does not claim built-in at-rest protection',
    passed: /stored as plaintext/i.test(threatModel) &&
      /not implemented/i.test(threatModel),
  });

  const claimPatterns = [
    /\b(?:vault|vault data|stored data|storage)\b.{0,80}\b(?:is|are|stays?|remains?)?\s*(?:fully\s+)?(?:encrypted|protected)\s+(?:at[- ]rest|on disk)\b/gi,
    /\bbuilt[- ]in\s+(?:at[- ]rest\s+)?(?:encryption|protection)\s+(?:is\s+)?(?:enabled|active|available)\b/gi,
    /\bpassword\b.{0,80}\bencrypts?\s+(?:the\s+)?(?:vault|data|storage)\b/gi,
  ];
  const protectedClaims = claimPatterns.flatMap((pattern) =>
    [...uiSources.matchAll(pattern)]
      .map((match) => match[0])
      .filter((claim) =>
        !/\b(?:does?|is|are|will|can)\s+not\b.{0,50}\b(?:encrypt|protect)/i.test(claim) &&
        !/\bnever\b.{0,50}\b(?:encrypt|protect)/i.test(claim),
      ),
  );
  results.push({
    name: 'no user-facing protected-at-rest product claim is enabled',
    passed: protectedClaims.length === 0,
    detail: protectedClaims.slice(0, 3).join(' | '),
  });

  return results;
}

function readUserFacingSources() {
  const sourceRoot = path.join(ROOT, 'client', 'src');
  const chunks = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (
        !/\.(?:ts|tsx|md)$/.test(entry.name) ||
        /\.(?:test|spec)\.[^.]+$/.test(entry.name)
      ) {
        continue;
      }
      chunks.push(fs.readFileSync(absolute, 'utf8'));
    }
  };
  visit(sourceRoot);
  return chunks.join('\n').replace(/\s+/g, ' ');
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  const results = checkProtectedVaultClaims();
  console.log(`${TAG} Results:`);
  for (const result of results) {
    console.log(
      `  ${result.passed ? 'PASS' : 'FAIL'}  ${result.name}` +
      (result.detail ? ` — ${result.detail}` : ''),
    );
  }
  if (results.some((result) => !result.passed)) {
    console.error(`${TAG} protected claim guard failed closed`);
    process.exit(1);
  }
  console.log(`${TAG} protection claims remain correctly gated`);
}