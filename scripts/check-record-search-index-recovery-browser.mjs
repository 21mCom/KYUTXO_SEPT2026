#!/usr/bin/env node
// Real-browser guard for recovery after a recordSearchIndex write fails.
//
// The source records are authoritative, but metadata search uses a bounded
// recent-record scan while its derived trigram index is cold or stale. This
// check exercises the failure and recovery path in a real Chromium session:
//   1. seed two old metadata records and 2,050 newer filler records
//   2. make one recordSearchIndex bulk write fail after updateRecord saves the
//      source note, using a browser-side QuotaExceededError
//   3. search while the rebuild is deliberately paused, proving the old note
//      and custom field are outside the bounded fallback window
//   4. release the rebuild and verify both metadata matches are found
//
// Everything runs offline against the browser's real IndexedDB. Usage:
// node scripts/check-record-search-index-recovery-browser.mjs

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import {
  completeFreshVaultOnboardingIfPresent,
  unlockIfNeeded,
} from './browser-check-utils.mjs';

const LABEL = 'record-search-index-recovery-browser';
const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PASSWORD = 'record-search-recovery-check-123';
const FILLER_COUNT = 2_050;
const OLD_UPDATED_AT = 1_000_000;
const FILLER_UPDATED_AT = 2_000_000;
const NOTE_QUERY = 'browser-recovered-note';
const CUSTOM_QUERY = 'browser-recovered-custom';

await acquireBrowserCheckLock(LABEL);

function resolveChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  try {
    return execSync('which chromium', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      'No `chromium` binary found on PATH. Install it (Nix: chromium) or set CHROMIUM_BIN.',
    );
  }
}

async function isServerUp() {
  try {
    const response = await fetch(BASE_URL);
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerUp()) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Dev server did not become ready at ${BASE_URL}`);
}

async function waitForIndexReady(page, timeoutMs = 30_000) {
  return page.evaluate(async (timeout) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const { db } = await import('/src/lib/database.ts');
      const state = await db.recordSearchIndexState.get('state');
      if (
        state?.status === 'ready' &&
        state.pendingMutations === 0 &&
        state.rebuilding === false
      ) {
        return state;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const { db } = await import('/src/lib/database.ts');
    return db.recordSearchIndexState.get('state');
  }, timeoutMs);
}

async function searchFor(page, query) {
  const input = page.getByTestId('input-command-search');
  await input.fill(query);
  await page.waitForTimeout(700);
}

async function main() {
  let devProc = null;
  let startedServer = false;
  const steps = [];

  if (!(await isServerUp())) {
    console.log(`[${LABEL}] starting dev server (npm run dev) ...`);
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    await waitForServer();
  }

  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });

    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 30_000, label: LABEL });
    // Saving a provider choice does not make a request. The harness performs no
    // sync/provider action, so all tested storage behavior remains local.
    await completeFreshVaultOnboardingIfPresent(page, { label: LABEL });
    await page.getByTestId('button-command-search').waitFor({
      state: 'visible',
      timeout: 30_000,
    });

    const seeded = await page.evaluate(async ({ fillerCount, oldUpdatedAt, fillerUpdatedAt }) => {
      const { createRecord, bulkCreateRecords } = await import('/src/lib/data/record-crud.ts');

      const noteId = await createRecord({
        type: 'other',
        inputString: 'browser-search-recovery-note-record',
        label: 'Old note recovery row',
        notes: 'initial note before browser failure',
        tags: [],
        categories: [],
        createdAt: oldUpdatedAt,
        updatedAt: oldUpdatedAt,
      }, { skipVocabularySync: true });
      const customId = await createRecord({
        type: 'other',
        inputString: 'browser-search-recovery-custom-record',
        label: 'Old custom recovery row',
        customFields: { reference: 'browser-recovered-custom-value' },
        tags: [],
        categories: [],
        createdAt: oldUpdatedAt + 1,
        updatedAt: oldUpdatedAt + 1,
      }, { skipVocabularySync: true });
      await bulkCreateRecords(
        Array.from({ length: fillerCount }, (_, index) => ({
          type: 'other',
          inputString: `browser-search-recovery-filler-${String(index).padStart(5, '0')}`,
          label: `Newer recovery filler ${index}`,
          tags: [],
          categories: [],
          createdAt: fillerUpdatedAt + index,
          updatedAt: fillerUpdatedAt + index,
        })),
        { skipVocabularySync: true },
      );

      const { db } = await import('/src/lib/database.ts');
      return {
        noteId,
        customId,
        recordCount: await db.records.count(),
        state: await db.recordSearchIndexState.get('state'),
      };
    }, { fillerCount: FILLER_COUNT, oldUpdatedAt: OLD_UPDATED_AT, fillerUpdatedAt: FILLER_UPDATED_AT });
    steps.push({
      name: 'seed two old metadata rows and 2,050 newer filler rows',
      passed:
        seeded.recordCount === FILLER_COUNT + 2 &&
        seeded.state?.status === 'ready',
      detail: JSON.stringify(seeded),
    });

    const failedWrite = await page.evaluate(async ({ noteId, oldUpdatedAt }) => {
      const { db } = await import('/src/lib/database.ts');
      const { updateRecord } = await import('/src/lib/data/record-crud.ts');
      const indexTable = db.recordSearchIndex;
      const originalBulkAdd = indexTable.bulkAdd;
      let failureCount = 0;
      let rebuildStarted = false;
      let releaseRebuild;
      const rebuildReleased = new Promise((resolve) => {
        releaseRebuild = resolve;
      });

      indexTable.bulkAdd = function (...args) {
        if (failureCount === 0) {
          failureCount += 1;
          throw new DOMException(
            'Injected recordSearchIndex storage failure',
            'QuotaExceededError',
          );
        }
        rebuildStarted = true;
        return rebuildReleased.then(() => originalBulkAdd.apply(this, args));
      };
      window.__releaseRecordSearchIndexRebuild = () => {
        releaseRebuild();
        indexTable.bulkAdd = originalBulkAdd;
      };

      try {
        // updateRecord writes the source row first; only the derived index write
        // is injected to fail.
        await updateRecord(
          noteId,
          { notes: 'browser-recovered-note-value' },
          { skipVocabularySync: true },
        );
        const saved = await db.records.get(noteId);
        // Keep the row outside the 2,000-row updatedAt fallback window while
        // retaining the new note written above.
        await db.records.update(noteId, { updatedAt: oldUpdatedAt });
        const state = await db.recordSearchIndexState.get('state');
        return {
          failureCount,
          sourceSaved: saved?.notes === 'browser-recovered-note-value',
          sourceUpdatedAt: (await db.records.get(noteId))?.updatedAt,
          state,
          rebuildStarted,
        };
      } finally {
        // The wrapper stays installed until the harness observes the paused
        // rebuild, then the outer cleanup restores the real Dexie method.
      }
    }, { noteId: seeded.noteId, oldUpdatedAt: OLD_UPDATED_AT });
    steps.push({
      name: 'one browser IndexedDB-style index write fails after the source note is saved',
      passed:
        failedWrite.failureCount === 1 &&
        failedWrite.sourceSaved &&
        failedWrite.sourceUpdatedAt === OLD_UPDATED_AT &&
        failedWrite.state?.status === 'building' &&
        failedWrite.state?.pendingMutations === 0 &&
        failedWrite.state?.rebuilding === true,
      detail: JSON.stringify(failedWrite),
    });

    await page.keyboard.press('Control+K');
    const commandInput = page.getByTestId('input-command-search');
    await commandInput.waitFor({ state: 'visible', timeout: 10_000 });

    await searchFor(page, NOTE_QUERY);
    const paused = await page.evaluate(async ({ noteId, customId }) => {
      const { db } = await import('/src/lib/database.ts');
      const [state, noteHits, customHits] = await Promise.all([
        db.recordSearchIndexState.get('state'),
        db.recordSearchIndex.where('recordId').equals(noteId).count(),
        db.recordSearchIndex.where('recordId').equals(customId).count(),
      ]);
      return {
        state,
        noteHits,
        customHits,
        rebuildReleaseInstalled: typeof window.__releaseRecordSearchIndexRebuild === 'function',
      };
    }, { noteId: seeded.noteId, customId: seeded.customId });
    const noteVisibleWhilePaused = await page.getByTestId(`command-record-${seeded.noteId}`).count();
    steps.push({
      name: 'next metadata search starts a rebuild instead of accepting the stale index',
      passed:
        paused.state?.status === 'building' &&
        paused.state?.rebuilding === true &&
        paused.rebuildReleaseInstalled &&
        noteVisibleWhilePaused === 0,
      detail: JSON.stringify({ ...paused, noteVisibleWhilePaused }),
    });

    await searchFor(page, CUSTOM_QUERY);
    const customVisibleWhilePaused = await page
      .getByTestId(`command-record-${seeded.customId}`)
      .count();
    steps.push({
      name: 'old custom-field metadata remains outside the bounded fallback while rebuilding',
      passed: customVisibleWhilePaused === 0,
      detail: `command-record-${seeded.customId} count=${customVisibleWhilePaused}`,
    });

    await page.evaluate(() => window.__releaseRecordSearchIndexRebuild?.());
    const readyState = await waitForIndexReady(page);
    steps.push({
      name: 'background metadata-index rebuild completes',
      passed:
        readyState?.status === 'ready' &&
        readyState?.pendingMutations === 0 &&
        readyState?.rebuilding === false,
      detail: JSON.stringify(readyState),
    });

    await searchFor(page, `${NOTE_QUERY} `);
    const recoveredNote = await page.getByTestId(`command-record-${seeded.noteId}`).count();
    steps.push({
      name: 'recovered note metadata is found after the rebuild',
      passed: recoveredNote === 1,
      detail: `command-record-${seeded.noteId} count=${recoveredNote}`,
    });

    await commandInput.fill('');
    await page.waitForTimeout(250);
    await searchFor(page, CUSTOM_QUERY);
    const recoveredCustom = await page.getByTestId(`command-record-${seeded.customId}`).count();
    steps.push({
      name: 'recovered custom-field metadata is found after the rebuild',
      passed: recoveredCustom === 1,
      detail: `command-record-${seeded.customId} count=${recoveredCustom}`,
    });

    await page.evaluate(() => {
      delete window.__releaseRecordSearchIndexRebuild;
    });
    if (pageErrors.length > 0) {
      steps.push({
        name: 'browser session has no unexpected page errors',
        passed: false,
        detail: JSON.stringify(pageErrors.slice(0, 5)),
      });
    }
  } finally {
    await browser.close();
    if (startedServer && devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        try {
          devProc.kill('SIGTERM');
        } catch {
          /* best effort */
        }
      }
    }
  }

  const ok = steps.every((step) => step.passed);
  console.log(`[${LABEL}] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }
  if (!ok) {
    console.error(`\n[${LABEL}] FAILED:`);
    for (const step of steps.filter((step) => !step.passed)) {
      console.error(`  - ${step.name}: ${step.detail}`);
    }
    process.exit(1);
  }
  console.log(
    `[${LABEL}] PASSED: a real browser recovered old note and custom-field metadata after one failed index write.`,
  );
}

main().catch((error) => {
  console.error(`[${LABEL}] ERROR:`, error?.stack ?? error);
  process.exit(1);
});