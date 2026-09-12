// Offline tests for the dependency-audit gate. Runs the real
// scripts/check-audit.js against fixture `npm audit --json` payloads via the
// CHECK_AUDIT_JSON_FILE / CHECK_AUDIT_ALLOWLIST_FILE hooks, so a broken gate
// (or a changed npm audit JSON shape) can't silently stop blocking releases.
//
// Run with: node --test scripts/check-audit.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT = path.resolve(path.dirname(__filename), 'check-audit.js');

const CLEAN_REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
  },
};

const VULNERABLE_REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {
    lodash: {
      name: 'lodash',
      severity: 'high',
      via: [
        {
          source: 1234567,
          name: 'lodash',
          title: 'Prototype Pollution in lodash',
          url: 'https://github.com/advisories/GHSA-1111-2222-3333',
          severity: 'high',
          range: '<4.17.21',
        },
      ],
      range: '<4.17.21',
      fixAvailable: true,
    },
    'left-pad': {
      name: 'left-pad',
      severity: 'critical',
      via: [
        {
          source: 7654321,
          name: 'left-pad',
          title: 'Bad thing',
          url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
          severity: 'critical',
          range: '*',
        },
      ],
      fixAvailable: false,
    },
    'transitive-ref': {
      severity: 'moderate',
      via: ['lodash'], // string via = resolution reference, must not count
      fixAvailable: true,
    },
  },
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 1, high: 1, critical: 1, total: 3 },
  },
};

const ERROR_RESPONSE = {
  error: {
    code: 'ENETUNREACH',
    summary: 'registry unreachable',
    detail: '',
  },
};

const FULL_ALLOWLIST = {
  allowlist: [
    { name: 'lodash', advisory: 'GHSA-1111-2222-3333', reason: 'fixture waiver' },
    { name: 'left-pad', advisory: 'ghsa-aaaa-bbbb-cccc', reason: 'case-insensitive match' },
  ],
};

const REASONLESS_ALLOWLIST = {
  allowlist: [
    { name: 'lodash', advisory: 'GHSA-1111-2222-3333', reason: '' },
    { name: 'left-pad', advisory: 'ghsa-aaaa-bbbb-cccc', reason: 'has a reason' },
  ],
};

function withTempFile(contents, fn) {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'check-audit-test-')),
    'fixture.json'
  );
  fs.writeFileSync(file, contents);
  try {
    return fn(file);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

function runGate({ report, allowlist }) {
  return withTempFile(
    typeof report === 'string' ? report : JSON.stringify(report),
    (reportFile) =>
      withTempFile(JSON.stringify(allowlist ?? { allowlist: [] }), (allowlistFile) =>
        spawnSync(process.execPath, [SCRIPT], {
          env: {
            ...process.env,
            CHECK_AUDIT_JSON_FILE: reportFile,
            CHECK_AUDIT_ALLOWLIST_FILE: allowlistFile,
          },
          encoding: 'utf8',
          timeout: 30_000,
        })
      )
  );
}

test('passes on a clean report', () => {
  const result = runGate({ report: CLEAN_REPORT });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

test('fails on unallowlisted high/critical findings', () => {
  const result = runGate({ report: VULNERABLE_REPORT });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL: 2 high\/critical/);
  assert.match(result.stderr, /GHSA-1111-2222-3333/i);
  assert.match(result.stderr, /GHSA-aaaa-bbbb-cccc/i);
});

test('passes when every finding is allowlisted with a reason', () => {
  const result = runGate({ report: VULNERABLE_REPORT, allowlist: FULL_ALLOWLIST });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WAIVED: lodash/);
});

test('allowlist entries without a documented reason do not waive', () => {
  const result = runGate({ report: VULNERABLE_REPORT, allowlist: REASONLESS_ALLOWLIST });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL: 1 high\/critical/);
  assert.match(result.stderr, /Prototype Pollution/);
});

test('fails closed on a valid-JSON npm audit error response', () => {
  const result = runGate({ report: ERROR_RESPONSE });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENETUNREACH/);
  assert.match(result.stderr, /could not be audited/);
});

test('fails closed when the vulnerabilities report object is missing', () => {
  const result = runGate({ report: { auditReportVersion: 2, metadata: {} } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing the "vulnerabilities"/);
});

test('fails closed on unparseable output', () => {
  const result = runGate({ report: 'this is not json' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unparseable/);
});
