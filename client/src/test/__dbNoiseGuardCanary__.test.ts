// @vitest-environment jsdom
// TEMPORARY canary written by scripts/check-db-noise-guard.js.
// If you are reading this in the repo, a guard run crashed mid-flight; delete it.
import { it } from "vitest";

class DatabaseClosedError extends Error {
  constructor() {
    super("DatabaseClosedError: canary — simulated unmocked Dexie CRUD call");
    this.name = "DatabaseClosedError";
  }
}

it("fires a hidden database rejection (must be failed by failOnDbErrorNoise)", async () => {
  // Fire-and-forget rejection, exactly what an unmocked getSettings() call
  // from a mounted component produces in jsdom.
  Promise.reject(new DatabaseClosedError());
  await new Promise((resolve) => setTimeout(resolve, 0));
});
