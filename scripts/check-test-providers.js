#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// Tooltip / AddressLink test-provider guard.
//
// Many components conditionally render clickable address links (AddressLink /
// TxidLink -> useRecordPreview) alongside Radix Tooltips. AddressLink throws
// when mounted outside a RecordPreviewProvider, which silently unmounts the
// whole tree and makes tests fail in confusing ways. Because the link is often
// rendered only conditionally, a test that wraps the component in just a bare
// `<TooltipProvider>` (without a RecordPreviewProvider) happens to pass today,
// but a future UI tweak that always mounts an AddressLink there would trip this
// latent fragility.
//
// We migrated those "partial provider" tests onto the shared harness
// `renderWithProviders` / `TestProviders` in client/src/test/testProviders.tsx,
// which wraps the full provider stack. This guard keeps new tests from silently
// reintroducing the fragility: it flags any test file that renders a
// `<TooltipProvider>` inline without also providing a RecordPreviewProvider
// (i.e. a "bare" TooltipProvider), and points the author at the shared harness.
//
// Run: node scripts/check-test-providers.js

const SCAN_DIR = path.resolve(ROOT, 'client/src');
const TEST_FILE_PATTERN = /\.test\.tsx?$/;

// Intentional-mock tests: these deliberately mock `@/contexts/RecordPreviewContext`
// and/or `AddressLink` to assert wiring in isolation, so they legitimately render
// a bare `<TooltipProvider>` without a real RecordPreviewProvider. They are exempt
// from this guard.
const ALLOWED_FILES = new Set([
  path.resolve(ROOT, 'client/src/components/__tests__/copy-button-toast.test.tsx'),
  path.resolve(ROOT, 'client/src/components/__tests__/copy-button-toast-extra.test.tsx'),
  path.resolve(ROOT, 'client/src/components/__tests__/copy-txid-confirmation.test.tsx'),
  path.resolve(ROOT, 'client/src/components/__tests__/hover-label-indicator.test.tsx'),
]);

// Matches an inline JSX opening tag, e.g. `<TooltipProvider>` or
// `<TooltipProvider ...>`. Importing the symbol alone does not trip the guard.
const TOOLTIP_PROVIDER_JSX = /<TooltipProvider[\s/>]/;
const RECORD_PREVIEW_PROVIDER_JSX = /<RecordPreviewProvider[\s/>]/;

function collectFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, files);
    } else if (TEST_FILE_PATTERN.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const files = collectFiles(SCAN_DIR);
const violations = [];

for (const file of files) {
  const resolved = path.resolve(file);
  if (ALLOWED_FILES.has(resolved)) continue;

  const contents = fs.readFileSync(file, 'utf-8');
  if (!TOOLTIP_PROVIDER_JSX.test(contents)) continue;
  // A bare TooltipProvider is fine as long as a RecordPreviewProvider is also
  // provided in the same tree (the full provider stack is present).
  if (RECORD_PREVIEW_PROVIDER_JSX.test(contents)) continue;

  const lines = contents.split('\n');
  const lineNumber = lines.findIndex((l) => TOOLTIP_PROVIDER_JSX.test(l)) + 1;
  violations.push({
    file: path.relative(ROOT, file),
    line: lineNumber > 0 ? lineNumber : 1,
    text: (lines[lineNumber - 1] || '').trim(),
  });
}

if (violations.length > 0) {
  console.error(
    '\x1b[31m%s\x1b[0m',
    `Found ${violations.length} test file(s) rendering a bare <TooltipProvider> ` +
      `without a RecordPreviewProvider:\n`
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}`);
    console.error(
      `    -> Use the shared harness renderWithProviders / TestProviders from ` +
        `client/src/test/testProviders.tsx instead.\n`
    );
  }
  console.error(
    `Why: components that conditionally render an AddressLink / TxidLink throw ` +
      `outside a RecordPreviewProvider. A bare <TooltipProvider> passes today but ` +
      `silently breaks the moment a UI tweak always mounts such a link.\n` +
      `If a test intentionally mocks @/contexts/RecordPreviewContext or AddressLink ` +
      `to assert wiring in isolation, add it to ALLOWED_FILES in ` +
      `scripts/check-test-providers.js.`
  );
  process.exit(1);
} else {
  console.log(
    '\x1b[32m%s\x1b[0m',
    `All Tooltip/AddressLink-capable tests use the shared provider harness ` +
      `(or a complete provider stack): no bare <TooltipProvider> found.`
  );
  console.log(`  Scanned ${files.length} test file(s) under client/src.`);
}
