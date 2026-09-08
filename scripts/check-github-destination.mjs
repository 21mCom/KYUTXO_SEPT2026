#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

export const EXPECTED_GITHUB_REPOSITORY = '21mCom/KYUTXO_SEPT2026';

export function repositoryFromRemote(remote) {
  const value = String(remote ?? '').trim().replace(/\/+$/, '');
  const httpsMatch = value.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (httpsMatch) return httpsMatch[1];

  const sshMatch = value.match(/^(?:ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (sshMatch) return sshMatch[1];

  return null;
}

export function assertExpectedGitHubDestination(value, source = 'GitHub destination') {
  const repository = value.includes('://') || value.startsWith('git@')
    ? repositoryFromRemote(value)
    : value.trim();

  if (repository !== EXPECTED_GITHUB_REPOSITORY) {
    throw new Error(
      `${source} must be ${EXPECTED_GITHUB_REPOSITORY}; received ${repository || value || '(empty)'}`,
    );
  }
}

function main() {
  const remote = process.argv[2];
  if (remote) {
    assertExpectedGitHubDestination(remote, 'Push remote');
  } else {
    assertExpectedGitHubDestination(process.env.GITHUB_REPOSITORY ?? '', 'GITHUB_REPOSITORY');
  }
  console.log(`GitHub destination verified: ${EXPECTED_GITHUB_REPOSITORY}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`GitHub destination check failed: ${error.message}`);
    process.exitCode = 1;
  }
}