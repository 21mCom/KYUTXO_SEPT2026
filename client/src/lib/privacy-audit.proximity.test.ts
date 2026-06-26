// Unit tests for the entity-proximity BFS engine (Task: "Write unit tests for
// the entity proximity BFS engine").
//
// `detectEntityProximity()` runs a bounded breadth-first search from every owned
// address through the local transaction graph (`ctx.participantsByTxid`) to find
// the shortest hop-distance to any address in the active entity list. These tests
// drive the engine directly by constructing an in-memory `AuditContext` (no Dexie,
// no React) and swapping the active entity list with `setActiveEntityList`, then
// assert on hop-count → severity scaling, hop-1 exclusion, de-duplication, the
// per-address BFS node cap, and the empty case.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { detectEntityProximity, type AuditContext } from "./privacy-audit";
import {
  setActiveEntityList,
  resetActiveEntityList,
  type EntityEntry,
} from "./privacy-entity-list";
import type { TransactionParticipant } from "./db-types";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const OWNED1 = "owned-address-1";
const OWNED2 = "owned-address-2";
const ENTITY_EXCHANGE = "exchange-entity-address";
const ENTITY_MIXER = "mixer-entity-address";

const EXCHANGE_ENTRY: EntityEntry = {
  address: ENTITY_EXCHANGE,
  name: "Test Exchange",
  category: "exchange",
  sourceNote: "test fixture",
};

const MIXER_ENTRY: EntityEntry = {
  address: ENTITY_MIXER,
  name: "Test Mixer",
  category: "mixer",
  sourceNote: "test fixture",
};

let pid = 0;
function part(txid: string, address: string): TransactionParticipant {
  return { id: ++pid, txid, role: "output", address, amount: 1000, vout: 0 };
}

/**
 * Build an `AuditContext` from a {txid → [addresses]} description and the set of
 * owned addresses. Only `userAddresses` + `participantsByTxid` are read by the
 * BFS, but the interface requires the other fields, so we stub them.
 */
function makeCtx(
  txs: Record<string, string[]>,
  owned: string[],
): AuditContext {
  const participantsByTxid = new Map<string, TransactionParticipant[]>();
  const participants: TransactionParticipant[] = [];
  for (const [txid, addrs] of Object.entries(txs)) {
    const parts = addrs.map((a) => part(txid, a));
    participantsByTxid.set(txid, parts);
    participants.push(...parts);
  }
  return {
    userAddresses: new Set(owned),
    participants,
    participantsByTxid,
    transactions: new Map(),
  };
}

beforeEach(() => {
  pid = 0;
  setActiveEntityList([EXCHANGE_ENTRY, MIXER_ENTRY]);
});

afterEach(() => {
  resetActiveEntityList();
});

describe("detectEntityProximity BFS engine", () => {
  it("emits a HIGH-severity finding for a hop-2 owned→entity path", () => {
    // owned1 → A (tx1) → exchange entity (tx2): the entity is 2 hops away.
    const ctx = makeCtx(
      {
        tx1: [OWNED1, "A"],
        tx2: ["A", ENTITY_EXCHANGE],
      },
      [OWNED1],
    );

    const findings = detectEntityProximity(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("PROXIMITY_EXCHANGE");
    expect(findings[0].severity).toBe("HIGH");
    expect(findings[0].details.hopDistance).toBe(2);
    expect(findings[0].details.isProximity).toBe(true);
    expect(findings[0].addresses).toEqual([OWNED1]);
  });

  it("emits a MEDIUM-severity finding for a hop-3 path", () => {
    // owned1 → A (tx1) → B (tx2) → exchange entity (tx3).
    const ctx = makeCtx(
      {
        tx1: [OWNED1, "A"],
        tx2: ["A", "B"],
        tx3: ["B", ENTITY_EXCHANGE],
      },
      [OWNED1],
    );

    const findings = detectEntityProximity(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("MEDIUM");
    expect(findings[0].details.hopDistance).toBe(3);
  });

  it("emits a LOW-severity finding for a hop-4 path", () => {
    // owned1 → A → B → C → exchange entity, spanning four transactions.
    const ctx = makeCtx(
      {
        tx1: [OWNED1, "A"],
        tx2: ["A", "B"],
        tx3: ["B", "C"],
        tx4: ["C", ENTITY_EXCHANGE],
      },
      [OWNED1],
    );

    const findings = detectEntityProximity(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("LOW");
    expect(findings[0].details.hopDistance).toBe(4);
  });

  it("does NOT emit a proximity finding for a hop-1 direct contact", () => {
    // owned1 shares a transaction directly with the entity. Direct contacts are
    // handled by detectEntityContacts, so proximity must stay silent.
    const ctx = makeCtx(
      {
        tx1: [OWNED1, ENTITY_EXCHANGE],
      },
      [OWNED1],
    );

    expect(detectEntityProximity(ctx)).toEqual([]);
  });

  it("does NOT emit anything beyond MAX_PROXIMITY_HOPS (hop 5)", () => {
    // owned1 → A → B → C → D → exchange entity: the entity sits 5 hops away,
    // one beyond the 4-hop search horizon.
    const ctx = makeCtx(
      {
        tx1: [OWNED1, "A"],
        tx2: ["A", "B"],
        tx3: ["B", "C"],
        tx4: ["C", "D"],
        tx5: ["D", ENTITY_EXCHANGE],
      },
      [OWNED1],
    );

    expect(detectEntityProximity(ctx)).toEqual([]);
  });

  it("de-duplicates: two owned addresses reaching the same entity at the same hop produce one finding", () => {
    // Both owned1 and owned2 reach the exchange entity at hop 2 via separate
    // intermediates. The engine groups by (category × hop), so one finding with
    // both owned addresses attached.
    const ctx = makeCtx(
      {
        tx1: [OWNED1, "A"],
        tx2: ["A", ENTITY_EXCHANGE],
        tx3: [OWNED2, "B"],
        tx4: ["B", ENTITY_EXCHANGE],
      },
      [OWNED1, OWNED2],
    );

    const findings = detectEntityProximity(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].details.hopDistance).toBe(2);
    expect(new Set(findings[0].addresses)).toEqual(new Set([OWNED1, OWNED2]));
  });

  it("emits separate findings per category at the same hop", () => {
    // owned1 reaches an exchange and a mixer, both at hop 2 → two findings.
    const ctx = makeCtx(
      {
        tx1: [OWNED1, "A"],
        tx2: ["A", ENTITY_EXCHANGE],
        tx3: [OWNED1, "B"],
        tx4: ["B", ENTITY_MIXER],
      },
      [OWNED1],
    );

    const findings = detectEntityProximity(ctx);
    const types = new Set(findings.map((f) => f.type));

    expect(findings).toHaveLength(2);
    expect(types).toEqual(new Set(["PROXIMITY_EXCHANGE", "PROXIMITY_MIXER"]));
  });

  it("reports only the closest hop per category from a single owned address", () => {
    // owned1 can reach the exchange entity at hop 2 (via A) and also at hop 3
    // (via C→D), but only the nearest (hop 2, HIGH) should be emitted.
    const ctx = makeCtx(
      {
        tx1: [OWNED1, "A", "C"],
        tx2: ["A", ENTITY_EXCHANGE],
        tx3: ["C", "D"],
        tx4: ["D", ENTITY_EXCHANGE],
      },
      [OWNED1],
    );

    const findings = detectEntityProximity(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].details.hopDistance).toBe(2);
    expect(findings[0].severity).toBe("HIGH");
  });

  it("terminates cleanly when the BFS node cap is exceeded (no throw)", () => {
    // A single transaction with well over MAX_BFS_NODES_PER_ADDRESS (800)
    // participants. After the first hop, visited.size exceeds the cap and BFS
    // breaks without exploring further. No entity is reachable → no findings.
    const fanOut: string[] = [OWNED1];
    for (let i = 0; i < 1000; i++) fanOut.push(`neighbor-${i}`);
    const ctx = makeCtx({ tx1: fanOut }, [OWNED1]);

    let findings: ReturnType<typeof detectEntityProximity> = [];
    expect(() => {
      findings = detectEntityProximity(ctx);
    }).not.toThrow();
    expect(findings).toEqual([]);
  });

  it("emits no finding for an owned address with no reachable entity", () => {
    const ctx = makeCtx(
      {
        tx1: [OWNED1, "A"],
        tx2: ["A", "B"],
        tx3: ["B", "C"],
      },
      [OWNED1],
    );

    expect(detectEntityProximity(ctx)).toEqual([]);
  });

  it("records the connecting txid for each hop alongside hopPath", () => {
    // owned1 → A (tx1) → B (tx2) → exchange entity (tx3): a hop-3 path whose
    // three transactions connect each consecutive pair in the hop path.
    const ctx = makeCtx(
      {
        tx1: [OWNED1, "A"],
        tx2: ["A", "B"],
        tx3: ["B", ENTITY_EXCHANGE],
      },
      [OWNED1],
    );

    const findings = detectEntityProximity(ctx);

    expect(findings).toHaveLength(1);
    const { hopPath, hopTxids } = findings[0].details as {
      hopPath: string[];
      hopTxids: string[];
    };
    expect(hopPath).toEqual([OWNED1, "A", "B", ENTITY_EXCHANGE]);
    // One connecting txid per consecutive pair (always hopPath.length - 1).
    expect(hopTxids).toHaveLength(hopPath.length - 1);
    expect(hopTxids).toEqual(["tx1", "tx2", "tx3"]);
  });

  it("records the single connecting txid for a hop-2 path", () => {
    const ctx = makeCtx(
      {
        tx1: [OWNED1, "A"],
        tx2: ["A", ENTITY_EXCHANGE],
      },
      [OWNED1],
    );

    const findings = detectEntityProximity(ctx);

    expect(findings).toHaveLength(1);
    const { hopPath, hopTxids } = findings[0].details as {
      hopPath: string[];
      hopTxids: string[];
    };
    expect(hopPath).toEqual([OWNED1, "A", ENTITY_EXCHANGE]);
    expect(hopTxids).toEqual(["tx1", "tx2"]);
  });

  it("returns no findings when the entity list is empty", () => {
    setActiveEntityList([]);
    const ctx = makeCtx(
      {
        tx1: [OWNED1, "A"],
        tx2: ["A", ENTITY_EXCHANGE],
      },
      [OWNED1],
    );

    expect(detectEntityProximity(ctx)).toEqual([]);
  });
});
