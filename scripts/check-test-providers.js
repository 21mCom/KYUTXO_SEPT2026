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
// TxidLink -> useRecordPreview) alongside Radix Tooltips. Both throw when
// mounted outside their provider:
//   - AddressLink / TxidLink throw outside a RecordPreviewProvider.
//   - Any Radix Tooltip (TooltipTrigger / TooltipContent) throws outside a
//     TooltipProvider ("`Tooltip` must be used within `TooltipProvider`").
// Either throw silently unmounts the whole tree and makes tests fail in
// confusing ways. Because the link / tooltip is often rendered only
// conditionally, a test wrapped in just ONE of the two providers (or in no
// provider at all) happens to pass today, but a future UI tweak that always
// mounts such a link / tooltip would trip this latent fragility.
//
// We migrated those "partial provider" tests onto the shared harness
// `renderWithProviders` / `TestProviders` in client/src/test/testProviders.tsx,
// which wraps the full provider stack
// (ActivityBusProvider -> TooltipProvider -> RecordPreviewProvider). This guard
// keeps new tests from silently reintroducing the fragility. It flags three
// symmetric patterns and points the author at the shared harness:
//
//   A. A bare `<TooltipProvider>` without a RecordPreviewProvider
//      (an AddressLink mounted there would throw).
//   B. A bare `<RecordPreviewProvider>` without a TooltipProvider
//      (the opposite gap: a Tooltip mounted there would throw).
//   C. A bare `render()` of a known tooltip-capable leaf component with NO
//      provider at all (neither TooltipProvider nor RecordPreviewProvider).
//
// Files that use the shared harness (renderWithProviders / TestProviders /
// renderWithSettingsProviders) get the full provider stack and are never
// flagged for B or C.
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
  path.resolve(ROOT, 'client/src/components/__tests__/preload-indicator.test.tsx'),
  path.resolve(ROOT, 'client/src/components/__tests__/ttl-refresh-indicator.test.tsx'),
]);

// Matches an inline JSX opening tag, e.g. `<TooltipProvider>` or
// `<TooltipProvider ...>`. Importing the symbol alone does not trip the guard.
const TOOLTIP_PROVIDER_JSX = /<TooltipProvider[\s/>]/;
const RECORD_PREVIEW_PROVIDER_JSX = /<RecordPreviewProvider[\s/>]/;

// A test that uses the shared harness gets the full provider stack (both
// TooltipProvider and RecordPreviewProvider), so it is safe by construction.
const SHARED_HARNESS = /\b(?:renderWithProviders|TestProviders|renderWithSettingsProviders)\b/;

// Known tooltip-capable LEAF components: reusable widgets that mount a Radix
// Tooltip (and, for the address/txid links, also need a RecordPreviewProvider)
// and are commonly rendered standalone in unit tests. A bare `render()` of one
// of these with neither provider in the tree throws the moment the tooltip /
// link mounts. Pages are intentionally excluded — they bring their own mock
// setup and are rarely rendered as isolated tooltip widgets.
const KNOWN_TOOLTIP_COMPONENTS = [
  'AddressLink',
  'TxidLink',
  'BitcoinAddressDisplay',
  'HopPathExplorer',
  'MetadataSourcesPanel',
  'ContinuityProof',
  'BlockchainToggle',
  'ContinuityCertificateReport',
];
const KNOWN_COMPONENT_JSX = new RegExp(
  `<(?:${KNOWN_TOOLTIP_COMPONENTS.join('|')})[\\s/>]`,
);

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

function firstMatchingLine(lines, regex) {
  const idx = lines.findIndex((l) => regex.test(l));
  return {
    line: idx >= 0 ? idx + 1 : 1,
    text: idx >= 0 ? lines[idx].trim() : '',
  };
}

const files = collectFiles(SCAN_DIR);
const violations = [];

for (const file of files) {
  const resolved = path.resolve(file);
  if (ALLOWED_FILES.has(resolved)) continue;

  const contents = fs.readFileSync(file, 'utf-8');
  const hasTooltipProvider = TOOLTIP_PROVIDER_JSX.test(contents);
  const hasRecordPreviewProvider = RECORD_PREVIEW_PROVIDER_JSX.test(contents);
  const usesHarness = SHARED_HARNESS.test(contents);
  const rendersKnownComponent = KNOWN_COMPONENT_JSX.test(contents);

  const relative = path.relative(ROOT, file);
  const lines = contents.split('\n');

  // A. Bare <TooltipProvider> without a RecordPreviewProvider.
  if (hasTooltipProvider && !hasRecordPreviewProvider) {
    const { line, text } = firstMatchingLine(lines, TOOLTIP_PROVIDER_JSX);
    violations.push({
      file: relative,
      line,
      text,
      kind: 'tooltip-without-record-preview',
      why:
        'a bare <TooltipProvider> passes today but an AddressLink / TxidLink ' +
        'mounted there throws outside a RecordPreviewProvider',
    });
    continue;
  }

  // B. Bare <RecordPreviewProvider> without a TooltipProvider (the opposite gap).
  if (hasRecordPreviewProvider && !hasTooltipProvider && !usesHarness) {
    const { line, text } = firstMatchingLine(lines, RECORD_PREVIEW_PROVIDER_JSX);
    violations.push({
      file: relative,
      line,
      text,
      kind: 'record-preview-without-tooltip',
      why:
        'a bare <RecordPreviewProvider> passes today but a Radix Tooltip ' +
        'mounted there throws outside a TooltipProvider',
    });
    continue;
  }

  // C. Bare render() of a known tooltip-capable leaf component with neither
  //    provider (and not via the shared harness).
  if (
    rendersKnownComponent &&
    !hasTooltipProvider &&
    !hasRecordPreviewProvider &&
    !usesHarness
  ) {
    const { line, text } = firstMatchingLine(lines, KNOWN_COMPONENT_JSX);
    violations.push({
      file: relative,
      line,
      text,
      kind: 'tooltip-capable-component-without-providers',
      why:
        'this renders a tooltip-capable component with no TooltipProvider / ' +
        'RecordPreviewProvider in the tree; it throws the moment the tooltip ' +
        'or address link mounts',
    });
    continue;
  }
}

if (violations.length > 0) {
  console.error(
    '\x1b[31m%s\x1b[0m',
    `Found ${violations.length} test file(s) rendering a Tooltip/AddressLink-` +
      `capable tree without the matching provider(s):\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.kind}]`);
    if (v.text) console.error(`    ${v.text}`);
    console.error(`    why: ${v.why}`);
    console.error(
      `    -> Use the shared harness renderWithProviders / TestProviders from ` +
        `client/src/test/testProviders.tsx instead.\n`,
    );
  }
  console.error(
    `Why this guard exists: components that conditionally render an AddressLink ` +
      `/ TxidLink throw outside a RecordPreviewProvider, and Radix Tooltips throw ` +
      `outside a TooltipProvider. A tree wrapped in only one of the two providers ` +
      `(or in none) passes today but silently breaks the moment a UI tweak always ` +
      `mounts such a link / tooltip.\n` +
      `If a test intentionally mocks @/contexts/RecordPreviewContext or AddressLink ` +
      `to assert wiring in isolation, add it to ALLOWED_FILES in ` +
      `scripts/check-test-providers.js.`,
  );
  process.exit(1);
} else {
  console.log(
    '\x1b[32m%s\x1b[0m',
    `All Tooltip/AddressLink-capable tests use the shared provider harness ` +
      `(or a complete provider stack): no missing-provider gaps found.`,
  );
  console.log(`  Scanned ${files.length} test file(s) under client/src.`);
}
