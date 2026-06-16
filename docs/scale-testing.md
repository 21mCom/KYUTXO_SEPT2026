# Scale Testing

For a long time, scale fixes looked "done" on a tiny dev database and then fell
over on the real vault. Nothing was ever exercised at real size. This is the
foundation that makes scale work **provable**: a way to generate a huge vault on
demand, a small pre-migration fixture, and automated guards that fail when a
change reintroduces an unbounded full-table load.

The real vault we keep failing on is roughly:

| Data            | Count       |
| --------------- | ----------- |
| Records         | ~100,000    |
| Transactions    | ~10,000,000 |
| Participants    | ~20,000,000 |
| Attachments     | ~5,000      |

---

## 1. Generating a large vault (manual testing)

The generator is a **developer-only** tool. It lives on the dev-only Test Data
page (`client/src/pages/DevTestData.tsx`), which is gated behind
`import.meta.env.DEV` — it never ships in a production build.

How to use it:

1. Run the app in development.
2. Open the **Test Data** page.
3. Find the **Large-Scale Vault (Scale Testing)** card.
4. Pick a preset or type your own counts:
   - **Moderate preset** — 5,000 records / 20,000 transactions / 40,000
     participants / 1,000 attachments. Finishes in well under a minute. Good for
     "does this page feel slow?" checks.
   - **Real-scale preset** — the ~30-million-row vault above. This is the real
     stress test. Expect it to run for **several minutes**.
5. The **Clear existing data** switch at the top of the page applies here too —
   leave it on to start from a clean vault.
6. Click **Generate Vault**. A progress bar shows the current phase
   (records → transactions → participants → attachments) and overall percent.
7. **Cancel** stops after the current batch. Whatever was written so far is
   kept, so you can cancel a real-scale run early and still test against a
   partial-but-large vault.

What it actually does (the important guarantees):

- **All writes go through the normal data layer** (the CRUD modules), so the
  generated data is shaped exactly like real data and the `crud-guards` check
  stays satisfied.
- It **never holds the whole dataset in memory**. Rows are built one batch at a
  time, written, and dropped. The only thing retained across batches is a
  compact list of address-record ids used to link participants and attachments
  to real records.
- It **yields to the event loop between batches**, so the UI stays responsive
  and the Cancel button keeps working during a long run.

Notes:

- Attachments are metadata rows only — no real file bytes are written.
- Generation is deterministic (synthetic addresses/txids derived from an index),
  so runs are reproducible.

---

## 2. Generating the legacy / pre-migration fixture

Some bugs only show up on **old** data — records and attachments written before
later migrations normalised them. The **Generate Legacy Fixture** button (same
card) writes a small set of deliberately pre-migration-shaped rows:

- **Records without `inputStringLower`** — the lowercase search index that the
  current write path always sets. This gives the runtime `repairInputStringLower`
  pass something to fix.
- **Attachments at a single-segment "root" path** (e.g. `legacy-doc-3.pdf`
  instead of a hashed `dir/opaque.pdf`) — this gives the runtime attachment-path
  repair something to fix.

This fixture is intentionally **small** — it is about *shape*, not scale.

There are **two** repair mechanisms that consume this legacy shape, and which one
runs depends on the database version when the rows are read:

1. **Runtime repair passes** — scan existing rows on every unlock (e.g.
   `repairInputStringLower`, attachment-path migration). The **Generate Legacy
   Fixture** button writes into the already up-to-date database, so it exercises
   *these*. Use it to verify the on-unlock repairs still do the right thing.
2. **One-time schema upgraders** — the Dexie `.upgrade()` callbacks in
   `database.ts` (e.g. the v30 upgrade that backfills `inputStringLower`). These
   run **once**, when an old vault is opened at a newer version. They can't be
   re-triggered on an already-current database, so they are exercised by the
   **migration-path harness test** (see `legacy-migration.test.ts` below), which
   seeds a database at the *old* version and reopens it at the current one to
   watch the real upgrade run end to end.

Both paths reuse the same `buildLegacyRecordRows` / `buildLegacyAttachmentRows`
builders, so there is one source of truth for "what pre-migration data looks
like".

> Why direct writes here? The CRUD layer always normalises data on write, so it
> can never produce the old shape. The builders + fixture live in
> `testSeedData.ts`, which is allow-listed by the CRUD guard precisely so it can
> write this legacy shape directly.

---

## 3. Running the scale guards (automated)

Four test files keep scale and migration regressions from creeping back in. Run
them with:

```bash
npx vitest run client/src/lib/largeScaleSeed.test.ts \
  client/src/lib/scale-guards.runtime.test.ts \
  client/src/lib/scale-guards.static.test.ts \
  client/src/lib/legacy-migration.test.ts
```

### `largeScaleSeed.test.ts`

Runs the generator and the legacy fixture against a real Dexie engine (via
`fake-indexeddb`) at a tiny scale. Verifies exact row counts, progress that ends
at 100% in the `done` phase, clear-then-regenerate, prompt `AbortSignal`
cancellation (partial data kept), and that the legacy fixture really omits
`inputStringLower` and uses root-path attachments.

### `scale-guards.runtime.test.ts`

The behavioural guard. It seeds a dataset, then wraps Dexie's `toArray` to count
exactly how many rows each helper pulls into memory:

- Paginated reads (`getTransactionsPageByBlockTime`,
  `getRecordsPageByIdReverseKeyset`) must pull **one page**, not the table.
- Indexed lookups (`getParticipantsByRecordIds`, `getAttachmentsByRecordId`) must
  pull **only matches**.
- Counts (`countTransactions`, `countAttachments`, etc.) must pull **zero rows** —
  a count must never become "load everything then take `.length`".
- **Negative controls** (`getAllTransactions`, `getAllAttachments`) deliberately
  load the whole table, proving the instrument can actually tell bounded from
  unbounded.

### `legacy-migration.test.ts`

The **migration-path harness**. It seeds a database at the **old** schema
version (v29 — records have no `inputStringLower` index or field), then reopens
it through the **real** `KYUTXODatabase` class so Dexie runs the genuine v30
upgrade callback from `database.ts`. It then asserts the upgrade backfilled
`inputStringLower`, that the newly-added index is actually **usable** (a lookup
`.where("inputStringLower")` returns the migrated record), and that attachments
survived. This is the only test that exercises the **one-time** upgraders end to
end — the runtime repair passes can't, because they only run on an
already-current database. It deliberately does **not** mock `@/lib/database`.

### `scale-guards.static.test.ts`

A "ratchet". It scans the client source for unbounded full-table access
patterns — `getAll*()` call-sites and direct
`db.<bigTable>.toArray()/.toCollection()` outside the CRUD definition modules —
and fails if the count exceeds `BASELINE` (currently **10**, the known existing
offenders). The count may only go **down**: introduce a new full-table load and
the test fails with the offending file/line. After you remove an offender, lower
`BASELINE` to lock in the win.

> These guards are about *bounded access*, complementary to the existing
> `crud-guards` check (which enforces that guarded tables are only written
> through their CRUD modules).
