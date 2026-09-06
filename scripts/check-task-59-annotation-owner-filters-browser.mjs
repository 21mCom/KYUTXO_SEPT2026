#!/usr/bin/env node
// Real-Chromium coverage for Task 59's common annotation and owner-filter
// contract.  This deliberately seeds through the public CRUD modules loaded by
// Vite: it must exercise the same IndexedDB and change notifications as the UI.
import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import {
  completeFreshVaultOnboardingIfPresent,
  unlockIfNeeded,
} from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const LABEL = 'task-59-annotation-owner-filters';
const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE = `http://localhost:${PORT}/`;
const PASSWORD = 'task-59-annotation-owner-filters';
const OWNER = 'Task 59 owner';
const OTHER_OWNER = 'Task 59 co-owner';
const ADDRESS = `bc1qtask59owned${'a'.repeat(27)}`;
const EXTERNAL = `bc1qtask59external${'b'.repeat(24)}`;
const TX = `59${'1'.repeat(62)}`;

function chromiumPath() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  try { return execSync('which chromium', { encoding: 'utf8' }).trim(); }
  catch { throw new Error('No chromium on PATH (set CHROMIUM_BIN).'); }
}
async function serverUp() {
  try { const response = await fetch(BASE); return response.ok || response.status < 500; } catch { return false; }
}
async function waitForServer() {
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    if (await serverUp()) return;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error(`Dev server did not become ready at ${BASE}`);
}
async function choose(page, testId, option) {
  await page.getByTestId(testId).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
async function openAndAssert(page, url, trigger) {
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 15_000, label: LABEL });
  await page.getByTestId(trigger).waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByTestId(trigger).click();
  await page.getByTestId('annotation-panel').waitFor({ state: 'visible', timeout: 15_000 });
  await page.keyboard.press('Escape');
}

async function main() {
  let server;
  let browser;
  const results = [];
  const check = (name, passed, detail = '') => results.push({ name, passed, detail });
  try {
    if (!await serverUp()) {
      server = spawn('npm', ['run', 'dev'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true, env: process.env });
      await waitForServer();
    }
    browser = await chromium.launch({
      executablePath: chromiumPath(), headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1200 } });
    const page = await context.newPage();
    await page.goto(`${BASE}records`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 30_000, dismissMigration: false, label: LABEL });
    await completeFreshVaultOnboardingIfPresent(page, { label: LABEL });

    const seeded = await page.evaluate(async ({ address, external, txid, owner, other }) => {
      const records = await import('/src/lib/data/record-crud.ts');
      const transactions = await import('/src/lib/data/transaction-crud.ts');
      const ours = await records.createRecord({ type: 'address', inputString: address, label: 'Task 59 owned', owner, walletName: 'Task 59 wallet', addressImportance: 'manual', categories: ['legacy-skip', 'legacy-map'], tags: ['task-59'] });
      const unassigned = await records.createRecord({ type: 'address', inputString: external, label: 'Task 59 unassigned', categories: ['legacy-map'] });
      await transactions.addTransaction({ txid, blockHeight: 850059, blockTime: 1_700_000_000, fee: 100, feeRate: 1, syncedAt: Date.now(), curationState: 'new' });
      await transactions.bulkAddParticipants([
        { txid, role: 'input', address, amount: 20_000, prevTxid: 'a'.repeat(64), prevVout: 0, recordId: ours },
        { txid, role: 'output', address, amount: 19_000, vout: 0, recordId: ours },
        { txid, role: 'output', address: external, amount: 900, vout: 1, recordId: unassigned },
      ]);
      // Context fixtures are isolated from the UI fixture, but use the same
      // normalized shapes to catch accidental classifier/sentence drift.
      const context = await import('/src/lib/annotation-context.ts');
      const transaction = { txid, blockHeight: 1, blockTime: 1, fee: 0, feeRate: 0, syncedAt: 1 };
      const own = (id, name = owner) => ({ id, type: 'address', inputString: `bc1q${id}`, label: '', owner: name, addressImportance: 'manual' });
      const ext = id => ({ id, type: 'address', inputString: `bc1qe${id}`, label: '', counterpartyType: 'individual' });
      const derive = (parts, rows) => context.deriveTransactionAnnotationContext({ transaction, participants: parts.map((p, i) => ({ txid, id: i + 1, amount: 1, ...p })), addressRecords: rows });
      const shapes = {
        receive: derive([{ role: 'output', address: 'r', recordId: 1 }], [own(1)]),
        send: derive([{ role: 'input', address: 's', recordId: 1 }, { role: 'output', address: 'e', recordId: 2 }], [own(1), ext(2)]),
        change: derive([{ role: 'input', address: 'a', recordId: 1 }, { role: 'output', address: 'b', recordId: 1 }], [own(1)]),
        consolidation: derive([{ role: 'input', address: 'a', recordId: 1 }, { role: 'input', address: 'b', recordId: 2 }, { role: 'output', address: 'c', recordId: 1 }], [own(1), own(2)]),
        transfer: derive([{ role: 'input', address: 'a', recordId: 1 }, { role: 'output', address: 'b', recordId: 2 }], [own(1), own(2, other)]),
        coinjoin: derive([{ role: 'input', address: 'a', recordId: 1 }, { role: 'input', address: 'b', recordId: 2 }, { role: 'output', address: 'x', amount: 7 }, { role: 'output', address: 'y', amount: 7 }, { role: 'output', address: 'z', amount: 7 }], [own(1), ext(2)]),
        undetermined: derive([{ role: 'input', address: '', recordId: 1 }, { role: 'output', address: 'x', recordId: 1 }], [own(1)]),
      };
      return { ours, unassigned, shapes: Object.fromEntries(Object.entries(shapes).map(([key, value]) => [key, { classification: value.classification, sentence: value.sentence, questions: value.questions }])) };
    }, { address: ADDRESS, external: EXTERNAL, txid: TX, owner: OWNER, other: OTHER_OWNER });
    const expected = { receive: 'receive', send: 'send', change: 'change', consolidation: 'consolidation', transfer: 'owner-transfer', coinjoin: 'coinjoin', undetermined: 'undetermined' };
    check('all seven transaction shapes derive their required classifications and sentences',
      Object.entries(expected).every(([key, value]) => seeded.shapes[key].classification === value && seeded.shapes[key].sentence.length > 20),
      JSON.stringify(seeded.shapes));

    // RecordTable's rows are keyed as row-record-{numeric record id}. Remount
    // after the CRUD write rather than racing its initial indexed-query
    // snapshot, then wait for that exact public selector.
    await page.goto(`${BASE}records`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 30_000, label: LABEL });
    const recordRow = page.getByTestId(`row-record-${seeded.ours}`);
    try {
      await recordRow.waitFor({ state: 'visible', timeout: 30_000 });
    } catch (error) {
      const diagnostic = await page.evaluate(async () => {
        const db = await import('/src/lib/database.ts');
        return {
          records: await db.db.records.toArray(),
          page: document.body.innerText.slice(0, 1_000),
        };
      });
      throw new Error(`RecordTable did not render seeded row: ${JSON.stringify(diagnostic)}`, { cause: error });
    }
    // Table rows have nested controls which can steal an actionability click;
    // dispatch on the public row itself to exercise its production onClick.
    await recordRow.dispatchEvent('click');
    await page.getByTestId('button-edit-panel').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('button-annotate-panel').click();
    const addressPanel = page.getByTestId('annotation-panel');
    try {
      await addressPanel.waitFor({ state: 'visible', timeout: 15_000 });
    } catch (error) {
      throw new Error(`Records annotation did not open: ${(await page.locator('body').innerText()).slice(0, 1_500)}`, { cause: error });
    }
    const addressFields = await addressPanel.locator('label').allTextContents();
    check('Records opens shared address AnnotationPanel with address fields only',
      addressFields.some(x => x.includes('Controlled by')) && !addressFields.some(x => x === 'Flow'), addressFields.join('|'));
    await page.keyboard.press('Escape');

    await openAndAssert(page, `${BASE}transactions`, `button-annotate-transaction-${TX}`);
    await openAndAssert(page, `${BASE}transaction-inbox`, `button-inbox-annotate-${TX}`);
    check('Transactions and Inbox open the shared AnnotationPanel', true);

    // UTXOs derives its current-output rows from the same participant fixture.
    // Annotating the output address must route through the provider-owned
    // panel rather than a second record dialog. The funding-transaction button
    // is intentionally conditional on its asynchronous lookup succeeding, so
    // it is not a deterministic assertion for this synthetic fixture.
    await page.goto(`${BASE}utxos`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 30_000, label: LABEL });
    const addressGroup = page.locator('[data-testid^="row-address-"]').first();
    await addressGroup.waitFor({ state: 'visible', timeout: 30_000 });
    await addressGroup.click();
    const utxoRow = page.locator('[data-testid^="row-utxo-"]').first();
    await utxoRow.waitFor({ state: 'visible', timeout: 30_000 });
    await utxoRow.dispatchEvent('click');
    await page.getByTestId('button-annotate-utxo-address').click();
    await page.getByTestId('annotation-panel').waitFor({ state: 'visible', timeout: 15_000 });
    await page.keyboard.press('Escape');
    check('UTXO output opens the shared AnnotationPanel', true);

    await page.goto(`${BASE}quick-tagger`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 30_000, label: LABEL });
    await page.getByTestId('textarea-paste-input').fill(ADDRESS);
    await page.getByTestId('button-parse-entries').click();
    await page.getByTestId('button-annotate-single-record').click();
    await page.getByTestId('annotation-panel').waitFor({ state: 'visible', timeout: 15_000 });
    await page.keyboard.press('Escape');
    check('Quick Tagger opens the shared AnnotationPanel', true);

    // Persist a transaction default and a leg override, then clear only the
    // override. This is intentionally checked in IndexedDB rather than relying
    // on Radix select button text.
    await page.goto(`${BASE}transactions`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 30_000, label: LABEL });
    await page.getByTestId(`button-annotate-transaction-${TX}`).click();
    const panel = page.getByTestId('annotation-panel');
    await panel.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'Received', exact: true }).click();
    // The second combobox belongs to the first participant leg.
    await panel.getByRole('combobox').nth(1).click();
    await page.getByRole('option', { name: 'Sent', exact: true }).click();
    await panel.getByRole('button', { name: 'Save annotation', exact: true }).click();
    const beforeClear = await page.evaluate(async (txid) => {
      const db = await import('/src/lib/database.ts');
      return {
        metadata: await db.db.transactionMetadata.where('txid').equals(txid).first(),
        legs: await db.db.transactionLegMetadata.where('txid').equals(txid).toArray(),
      };
    }, TX);
    check('transaction default and per-leg override persist',
      beforeClear.metadata?.flowType === 'received' && beforeClear.legs.some(leg => leg.flowType === 'sent'),
      JSON.stringify(beforeClear));
    await page.getByTestId(`button-annotate-transaction-${TX}`).click();
    await panel.getByRole('button', { name: 'Use transaction defaults', exact: true }).first().click();
    await panel.getByRole('button', { name: 'Save annotation', exact: true }).click();
    const afterClear = await page.evaluate(async (txid) => {
      const db = await import('/src/lib/database.ts');
      return {
        metadata: await db.db.transactionMetadata.where('txid').equals(txid).first(),
        legs: await db.db.transactionLegMetadata.where('txid').equals(txid).toArray(),
      };
    }, TX);
    check('clearing a per-leg override retains the transaction default',
      afterClear.metadata?.flowType === 'received' && afterClear.legs.length === 0, JSON.stringify(afterClear));

    // Owner controls share the named + synthetic Unassigned vocabulary. Empty
    // selections are the all-owners default; check it on the principal pages.
    const ownerControls = [
      ['records', 'select-owner-filter'], ['utxos', 'select-owner'],
      ['reports', 'select-privacy-report-owner'], ['coin-origins', 'coin-origin-owner'],
    ];
    for (const [route, testId] of ownerControls) {
      await page.goto(`${BASE}${route}`, { waitUntil: 'load', timeout: 60_000 });
      await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 15_000, label: LABEL });
      if (route === 'reports') {
        await page.getByTestId('tab-privacy-report').click();
      }
      const control = page.getByTestId(testId);
      await control.waitFor({ state: 'visible', timeout: 30_000 });
      const defaultText = await control.textContent();
      await control.click();
      const named = page.getByRole('option', { name: OWNER, exact: true });
      const unassigned = page.getByRole('option', { name: 'Unassigned', exact: true });
      await named.waitFor({ state: 'visible', timeout: 15_000 });
      await unassigned.waitFor({ state: 'visible', timeout: 15_000 });
      await named.click(); await unassigned.click(); await page.keyboard.press('Escape');
      const selectedText = await control.textContent();
      const ownerPicker = control.locator('xpath=..');
      const selectedLabels = await ownerPicker.textContent();
      // Selected values render as removable badges before the combobox trigger.
      // Remove the first badge twice; after each render the remaining badge
      // becomes the first button, while the combobox stays last.
      await ownerPicker.locator('button').first().click();
      await ownerPicker.locator('button').first().click();
      check(`${route} Owner accepts named plus Unassigned and clears to all`,
        /(all owners|filter by owner)/i.test(defaultText ?? '') &&
          selectedText === '2 selected' &&
          selectedLabels?.includes(OWNER) &&
          selectedLabels?.includes('Unassigned') &&
          /(all owners|filter by owner)/i.test((await control.textContent()) ?? ''),
        `default=${JSON.stringify(defaultText)} selected=${JSON.stringify(selectedText)} labels=${JSON.stringify(selectedLabels)}`);
    }

    // Inbox serializes the same owner array in a saved view. Its advanced
    // filter owns the shared TransactionSearchFilters control.
    await page.goto(`${BASE}transaction-inbox`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 30_000, label: LABEL });
    await page.getByTestId('button-advanced-filters').click();
    await choose(page, 'select-entity-owner', OWNER);
    const inboxUnassigned = page.getByRole('option', { name: 'Unassigned', exact: true });
    await inboxUnassigned.waitFor({ state: 'visible', timeout: 15_000 });
    await inboxUnassigned.dispatchEvent('click');
    check('Inbox advanced filter exposes named and Unassigned owner options', true);

    // Category decisions remain draftable, skipped values remain visible but
    // read-only, and reconsider restores the editable decision selector.
    await page.goto(`${BASE}settings`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 30_000, label: LABEL });
    const category = page.getByTestId('category-mapping-legacy-skip');
    await category.waitFor({ state: 'visible', timeout: 30_000 });
    await category.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'Skip for now', exact: true }).click();
    await category.getByText(/Skipped — remains unchanged/i).waitFor({ state: 'visible' });
    await category.getByRole('button', { name: /Reconsider/i }).click();
    await category.getByRole('combobox').first().waitFor({ state: 'visible' });
    const mapped = page.getByTestId('category-mapping-legacy-map');
    await mapped.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'Drop', exact: true }).click();
    await page.getByTestId('button-apply-category-mapping').click();
    check('Map your categories supports skip, reconsider, draft apply, and resume', true);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill('SIGTERM'); } }
  }
  const failed = results.filter(result => !result.passed);
  for (const result of results) console.log(`[${LABEL}] ${result.passed ? 'PASS' : 'FAIL'} ${result.name} ${result.detail}`);
  if (failed.length) throw new Error(`${failed.length} checks failed`);
}
main().catch(error => { console.error(`[${LABEL}]`, error); process.exit(1); });