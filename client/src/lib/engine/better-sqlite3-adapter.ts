/**
 * better-sqlite3 adapter — implements the engine's `EngineDb` driver contract on
 * top of the native better-sqlite3 binding.
 *
 * This is a NODE-ONLY module (native addon). It is imported by:
 *   - the Node engine worker that runs inside Electron's process,
 *   - the Vitest correctness suite, and
 *   - the at-scale benchmark script.
 * It must NEVER be imported by renderer/browser code (the renderer talks to the
 * engine over IPC). Keeping production, tests, and the benchmark on the SAME
 * driver means the exact SQL we ship is the SQL we prove.
 */
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database, Statement } from 'better-sqlite3';
import type { EngineDb } from './engine-core';

export interface BetterSqlite3EngineDb extends EngineDb {
  /** Escape hatch to the underlying handle (file stats, close, etc.). */
  readonly raw: BetterSqlite3Database;
  /** Close the connection and drop the prepared-statement cache. */
  close(): void;
}

/**
 * Wrap an already-open better-sqlite3 handle as an `EngineDb`.
 *
 * Prepared statements are cached by SQL text so repeated queries (and the
 * per-batch seedMeta upsert) do not recompile. `selectScalar` reads the first
 * column of the first row WITHOUT using better-sqlite3's `.pluck()` mode, which
 * is sticky and would corrupt a cached statement shared with `selectRows`.
 */
export function wrapBetterSqlite3(raw: BetterSqlite3Database): BetterSqlite3EngineDb {
  const cache = new Map<string, Statement>();

  const prep = (sql: string): Statement => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = raw.prepare(sql);
      cache.set(sql, stmt);
    }
    return stmt;
  };

  return {
    raw,

    exec(sql: string): void {
      raw.exec(sql);
    },

    run(sql: string, bind: unknown[] = []): void {
      prep(sql).run(...(bind as never[]));
    },

    selectRows<T = Record<string, unknown>>(sql: string, bind: unknown[] = []): T[] {
      return prep(sql).all(...(bind as never[])) as T[];
    },

    selectScalar(sql: string, bind: unknown[] = []): number {
      const row = prep(sql).get(...(bind as never[])) as Record<string, unknown> | undefined;
      if (!row) return 0;
      const v = Object.values(row)[0];
      return typeof v === 'number' ? v : Number(v ?? 0);
    },

    insertMany(sql: string, rows: unknown[][]): void {
      if (rows.length === 0) return;
      const stmt = prep(sql);
      const runBatch = raw.transaction((batch: unknown[][]) => {
        for (const tuple of batch) stmt.run(...(tuple as never[]));
      });
      runBatch(rows);
    },

    transaction(fn: () => void): void {
      raw.transaction(fn)();
    },

    close(): void {
      cache.clear();
      raw.close();
    },
  };
}

export interface OpenEngineDbOptions {
  /** Open read-only (used for verification reopens). */
  readonly?: boolean;
}

/**
 * Open a better-sqlite3 database at `filename` (use ':memory:' for an in-memory
 * DB) and wrap it. Durable connection pragmas are NOT applied here — callers
 * decide policy via `applyConnectionPragmas` / `applyBulkLoadPragmas` from
 * engine-core, because the bulk-load and steady-state phases want different
 * `synchronous` settings.
 */
export function openEngineDb(
  filename: string,
  opts: OpenEngineDbOptions = {},
): BetterSqlite3EngineDb {
  const raw = new Database(filename, { readonly: opts.readonly ?? false });
  return wrapBetterSqlite3(raw);
}

/** Convenience for tests/benchmarks: a fresh in-memory engine database. */
export function createInMemoryEngineDb(): BetterSqlite3EngineDb {
  return wrapBetterSqlite3(new Database(':memory:'));
}
