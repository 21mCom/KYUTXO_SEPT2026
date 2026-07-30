#!/usr/bin/env node

// Fails the build when `npm audit` reports high or critical vulnerabilities,
// so newly-introduced vulnerable dependencies can't ship unnoticed.
// Genuinely unfixable findings can be allowlisted in scripts/audit-allowlist.json
// with a documented reason.

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const ALLOWLIST_FILE = process.env.CHECK_AUDIT_ALLOWLIST_FILE
  ? path.resolve(process.env.CHECK_AUDIT_ALLOWLIST_FILE)
  : path.resolve(__dirname, 'audit-allowlist.json');
const FAILING_SEVERITIES = new Set(['high', 'critical']);

function runAudit() {
  // Test hook: read a captured `npm audit --json` payload from disk instead of
  // hitting the registry (used to verify the pass/fail logic offline).
  if (process.env.CHECK_AUDIT_JSON_FILE) {
    return fs.readFileSync(process.env.CHECK_AUDIT_JSON_FILE, 'utf8');
  }
  try {
    // npm audit exits non-zero when vulnerabilities exist, so capture stdout
    // from either path rather than treating the exit code as fatal.
    //
    // On Windows npm is npm.cmd, which execFileSync can't launch directly
    // (ENOENT without a shell; Node >=20.12 refuses .cmd spawns entirely
    // unless shell is set). Command and args are fixed strings, so shell
    // mode introduces no injection surface.
    return execFileSync('npm', ['audit', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
  } catch (error) {
    if (error.stdout) {
      return error.stdout;
    }
    console.error(
      `[check-audit] FAIL: could not run "npm audit --json": ${error.message}\n` +
        'Refusing to pass — fix the audit invocation rather than skipping this check.'
    );
    process.exit(1);
  }
}

function parseAudit(json) {
  let report;
  try {
    report = JSON.parse(json);
  } catch (error) {
    console.error(
      `[check-audit] FAIL: "npm audit --json" produced unparseable output: ${error.message}\n` +
        'Refusing to pass — the dependency tree could not be audited.'
    );
    process.exit(1);
  }

  // Fail closed: npm audit reports registry/network/auth failures as a VALID
  // JSON error body (e.g. { "error": { "code": "ENETUNREACH" } }) with exit
  // code 1. Such a payload has no "vulnerabilities" map, so without these
  // guards it would be misread as a clean tree and the gate would pass
  // without any audit having happened.
  if (report && typeof report === 'object' && report.error) {
    const code = report.error.code ?? 'unknown';
    const summary = report.error.summary ?? report.error.detail ?? '';
    console.error(
      `[check-audit] FAIL: npm audit could not complete (${code})${summary ? `: ${summary}` : ''}\n` +
        'Refusing to pass — the dependency tree could not be audited.'
    );
    process.exit(1);
  }
  if (
    !report ||
    typeof report !== 'object' ||
    typeof report.vulnerabilities !== 'object' ||
    report.vulnerabilities === null ||
    Array.isArray(report.vulnerabilities)
  ) {
    console.error(
      '[check-audit] FAIL: npm audit output is missing the "vulnerabilities" report object.\n' +
        'Refusing to pass — the dependency tree could not be audited.'
    );
    process.exit(1);
  }
  return report;
}

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_FILE)) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, 'utf8'));
  } catch (error) {
    console.error(`[check-audit] FAIL: ${ALLOWLIST_FILE} is not valid JSON: ${error.message}`);
    process.exit(1);
  }
  if (!parsed || !Array.isArray(parsed.allowlist)) {
    console.error(
      `[check-audit] FAIL: ${ALLOWLIST_FILE} must be an object with an "allowlist" array.`
    );
    process.exit(1);
  }
  return parsed.allowlist;
}

function advisoryId(via) {
  // Prefer the stable GHSA slug from the advisory URL; fall back to the
  // numeric source id for non-GitHub advisories.
  const match = typeof via.url === 'string' ? via.url.match(/GHSA-[a-z0-9-]+/i) : null;
  if (match) return match[0].toLowerCase();
  return String(via.source ?? '');
}

function collectFindings(report) {
  const findings = [];
  const vulnerabilities = report.vulnerabilities ?? {};
  for (const [packageName, info] of Object.entries(vulnerabilities)) {
    const vias = Array.isArray(info.via) ? info.via : [];
    for (const via of vias) {
      if (typeof via === 'string') continue; // resolution reference, not an advisory
      const severity = via.severity ?? info.severity;
      if (!FAILING_SEVERITIES.has(severity)) continue;
      findings.push({
        package: packageName,
        severity,
        title: via.title ?? '(no title)',
        id: advisoryId(via),
        url: via.url ?? '',
        range: via.range ?? info.range ?? '',
        fixAvailable: Boolean(info.fixAvailable),
      });
    }
  }
  return findings;
}

function isAllowlisted(finding, allowlist) {
  return allowlist.find(
    (entry) =>
      entry &&
      entry.name === finding.package &&
      String(entry.advisory ?? '').toLowerCase() === finding.id.toLowerCase() &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0
  );
}

function main() {
  const report = parseAudit(runAudit());
  const allowlist = loadAllowlist();
  const findings = collectFindings(report);

  const blocked = [];
  const waived = [];
  for (const finding of findings) {
    const entry = isAllowlisted(finding, allowlist);
    if (entry) {
      waived.push({ finding, reason: entry.reason });
    } else {
      blocked.push(finding);
    }
  }

  const totals = report.metadata?.vulnerabilities ?? {};
  console.log(
    `[check-audit] npm audit totals: ${totals.critical ?? 0} critical / ${totals.high ?? 0} high / ` +
      `${totals.moderate ?? 0} moderate / ${totals.low ?? 0} low`
  );

  for (const { finding, reason } of waived) {
    console.log(
      `[check-audit] WAIVED: ${finding.package} (${finding.severity}) ${finding.id} — ${reason}`
    );
  }

  if (blocked.length === 0) {
    console.log('[check-audit] OK: no unallowlisted high/critical vulnerabilities found');
    process.exit(0);
  }

  console.error(
    `[check-audit] FAIL: ${blocked.length} high/critical vulnerabilit${blocked.length === 1 ? 'y' : 'ies'} found:\n`
  );
  for (const finding of blocked.slice(0, 30)) {
    console.error(
      `  [${finding.severity}] ${finding.package}: ${finding.title}\n` +
        `    advisory: ${finding.id}${finding.url ? ` (${finding.url})` : ''}\n` +
        `    affected: ${finding.range || 'unknown range'} | fixAvailable: ${finding.fixAvailable}`
    );
  }
  if (blocked.length > 30) {
    console.error(`  ...and ${blocked.length - 30} more`);
  }
  console.error(
    '\nTo fix: upgrade the affected dependency or add a targeted "overrides" entry in package.json\n' +
      '(never "npm audit fix --force" — it downgrades electron-builder).\n' +
      'If a finding is genuinely unfixable, add it to scripts/audit-allowlist.json with a reason.'
  );
  process.exit(1);
}

main();
