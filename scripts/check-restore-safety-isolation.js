#!/usr/bin/env node
// Guard the boundary between the Transaction Inbox journey and the focused
// encrypted-backup restore proof. Restore dependencies in the inbox check make
// an unrelated feature edit capable of weakening a destructive-operation
// safety proof, while missing validation wiring makes the focused proof inert.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.CHECK_RESTORE_SAFETY_ROOT
  ? path.resolve(process.env.CHECK_RESTORE_SAFETY_ROOT)
  : path.resolve(scriptDir, '..');
const inboxRelative = 'scripts/check-transaction-inbox-saved-view-snooze-browser.mjs';
const focusedRelative = 'scripts/check-encrypted-backup-restore-safety-browser.mjs';
const dotReplitRelative = '.replit';
const guardWorkflow = 'restore-safety-isolation-guard';
const focusedWorkflow = 'encrypted-backup-restore-safety-browser-check';
const failures = [];

function readRequired(relative) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) {
    failures.push(`${relative} is missing.`);
    return '';
  }
  return fs.readFileSync(absolute, 'utf8');
}

function workflowBlock(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(
    new RegExp(
      `\\[\\[workflows\\.workflow\\]\\]\\s*\\nname\\s*=\\s*"${escaped}"[\\s\\S]*?(?=\\n\\[\\[workflows\\.workflow\\]\\]|$)`,
    ),
  );
  return match?.[0] ?? '';
}

const inbox = readRequired(inboxRelative);
readRequired(focusedRelative);
const dotReplit = readRequired(dotReplitRelative);

// Intentionally broad: this journey has no reason to name or import backup or
// restore concepts. Catching comments and fixture names prevents old coupled
// steps from being left behind as misleading scaffolding.
const coupledLines = inbox
  .split('\n')
  .map((line, index) => ({ line, number: index + 1 }))
  .filter(({ line }) => /\b(?:backup|restore)\w*\b|JSZip|input-restore|button-open-restore/i.test(line));
for (const hit of coupledLines) {
  failures.push(
    `${inboxRelative}:${hit.number} references restore/backup behavior: ${hit.line.trim()}`,
  );
}

const focusedBlock = workflowBlock(dotReplit, focusedWorkflow);
if (!focusedBlock) {
  failures.push(`${focusedWorkflow} is not registered as a workflow in .replit.`);
} else {
  if (!focusedBlock.includes(`node ${focusedRelative}`)) {
    failures.push(`${focusedWorkflow} no longer runs ${focusedRelative}.`);
  }
  if (!/\bisValidation\s*=\s*true\b/.test(focusedBlock)) {
    failures.push(`${focusedWorkflow} is no longer marked isValidation = true.`);
  }
}

const guardBlock = workflowBlock(dotReplit, guardWorkflow);
if (!guardBlock || !/\bisValidation\s*=\s*true\b/.test(guardBlock)) {
  failures.push(`${guardWorkflow} must exist and be marked isValidation = true.`);
}
if (!guardBlock.includes('node scripts/check-restore-safety-isolation.js') ||
    !guardBlock.includes('node --test scripts/check-restore-safety-isolation.test.mjs')) {
  failures.push(`${guardWorkflow} must run both the guard and its script tests.`);
}

const projectBlock = workflowBlock(dotReplit, 'Project');
if (!new RegExp(`args\\s*=\\s*"${guardWorkflow}"`).test(projectBlock)) {
  failures.push(`${guardWorkflow} is missing from the normal Project validation set.`);
}

if (failures.length > 0) {
  console.error('check-restore-safety-isolation: FAILED\n');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log(
  'check-restore-safety-isolation: OK — inbox is restore-independent and the focused proof plus guard remain in validation.',
);