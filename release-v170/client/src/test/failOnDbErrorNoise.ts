// Global vitest setup: fail tests on hidden database error noise.
//
// Why: a test that mounts a component calling a Dexie-backed CRUD module
// (e.g. @/lib/data/settings-crud) without mocking it produces fire-and-forget
// promise rejections (DatabaseClosedError, "IndexedDB API missing", ...).
// Those rejections are either (a) truly unhandled — vitest prints them as
// noise but the test itself can still pass — or (b) swallowed by Dexie's own
// unhandled-rejection logging, which only surfaces as console output. Both
// modes mask real failures. This hook turns them into hard test failures.
//
// Mechanisms:
//   1. process "unhandledRejection" listener — captures rejections that
//      escape the test body (works for node and jsdom pools alike).
//   2. console.error/console.warn patch — Dexie logs "Unhandled rejection:
//      DatabaseClosedError ..." itself instead of letting it escape; we only
//      match database-specific noise here so legitimate console output in
//      tests is unaffected.
//
// Each test gets a post-test macrotask flush so rejections scheduled during
// the test have landed before we assert. Failures name the offending test.
//
// Guarded by scripts/check-db-noise-guard.js (registered validation), which
// verifies this file stays wired into vitest.config.ts setupFiles and that a
// canary unhandled DatabaseClosedError still trips it.

import { afterAll, afterEach } from "vitest";

const NOISE_TAG = "[db-error-noise]";

// Console noise we treat as a hidden database error. Deliberately narrow:
// generic console.error calls in tests must not trip this.
const CONSOLE_NOISE = /DatabaseClosedError|Dexie.*Unhandled rejection|Unhandled rejection.*Dexie|indexedDB API missing/i;

const captured: string[] = [];

function describeReason(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  return String(reason);
}

const onUnhandledRejection = (reason: unknown) => {
  captured.push(`unhandled rejection: ${describeReason(reason)}`);
};
process.on("unhandledRejection", onUnhandledRejection);

for (const method of ["error", "warn"] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    const text = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" ");
    if (CONSOLE_NOISE.test(text)) {
      captured.push(`console.${method} database noise: ${text.slice(0, 300)}`);
    }
    original(...args);
  };
}

function flushAndAssert(context: string) {
  if (captured.length === 0) return;
  const details = captured.splice(0, captured.length).join("\n  - ");
  throw new Error(
    `${NOISE_TAG} hidden database error detected ${context}:\n  - ${details}\n` +
      `A component under test is hitting a real Dexie-backed CRUD module ` +
      `(e.g. @/lib/data/settings-crud) without a mock. Mock the CRUD module ` +
      `(see client/src/pages/BalanceOverview.resolveAddress.test.tsx) or await ` +
      `and handle the rejection explicitly.`,
  );
}

afterEach(async ({ task }) => {
  // Let rejections scheduled during the test land (rejection detection is
  // macrotask-delayed).
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushAndAssert(`during test "${task.name}"`);
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushAndAssert("after the last test in this file");
  process.off("unhandledRejection", onUnhandledRejection);
});
