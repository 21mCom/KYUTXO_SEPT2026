#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const GITHUB_ACTIONS_CRON_FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

function validValue(value, minimum, maximum) {
  return /^\d+$/.test(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function validatePart(part, minimum, maximum) {
  const slashParts = part.split('/');
  if (slashParts.length > 2) return false;

  const [range, step] = slashParts;
  if (step !== undefined && (!/^\d+$/.test(step) || Number(step) === 0)) return false;
  if (range === '*') return true;

  const bounds = range.split('-');
  if (bounds.length === 1) return validValue(bounds[0], minimum, maximum);
  return (
    bounds.length === 2 &&
    validValue(bounds[0], minimum, maximum) &&
    validValue(bounds[1], minimum, maximum) &&
    Number(bounds[0]) <= Number(bounds[1])
  );
}

export function validateGitHubActionsCron(expression) {
  if (typeof expression !== 'string') return false;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== GITHUB_ACTIONS_CRON_FIELD_RANGES.length) return false;

  return fields.every((field, index) => {
    const [minimum, maximum] = GITHUB_ACTIONS_CRON_FIELD_RANGES[index];
    const parts = field.split(',');
    return parts.length > 0 && parts.every((part) => part !== '' && validatePart(part, minimum, maximum));
  });
}

export function workflowFiles(workflowsDirectory) {
  return fs
    .readdirSync(workflowsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => path.join(workflowsDirectory, entry.name))
    .sort();
}

export function checkWorkflowSchedules(workflowsDirectory) {
  const files = workflowFiles(workflowsDirectory);
  const schedules = [];
  const errors = [];

  for (const file of files) {
    let document;
    try {
      document = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      errors.push(`${path.basename(file)}: malformed YAML (${error.message})`);
      continue;
    }

    const schedule = document?.on?.schedule;
    if (schedule === undefined) continue;
    if (!Array.isArray(schedule)) {
      errors.push(`${path.basename(file)}: on.schedule must be a list`);
      continue;
    }

    for (const [index, entry] of schedule.entries()) {
      const cron = entry?.cron;
      schedules.push({ file, index, cron });
      if (!validateGitHubActionsCron(cron)) {
        errors.push(
          `${path.basename(file)}: on.schedule[${index}].cron is not a valid GitHub Actions five-field schedule: ${JSON.stringify(cron)}`,
        );
      }
    }
  }

  return { files, schedules, errors };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const workflowsDirectory = path.join(root, '.github', 'workflows');
  const result = checkWorkflowSchedules(workflowsDirectory);

  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`[workflow-schedules] FAIL: ${error}`);
    process.exit(1);
  }

  console.log(
    `[workflow-schedules] PASS: validated ${result.schedules.length} schedule(s) across ${result.files.length} workflow file(s)`,
  );
}