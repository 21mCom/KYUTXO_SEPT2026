/**
 * Engine bootstrap + maintenance (Task #300).
 *
 * Before this, the native read-engine was only ever seeded MANUALLY from the
 * EngineDiagnostics page, so the live app never used the fast path unless someone
 * remembered to seed it. This module makes the desktop app self-maintain the
 * mirror at launch: seed it when empty, refresh it once when it has drifted from
 * the live vault, and otherwise leave it alone. It is a strict no-op in the
 * browser preview (there is no engine there).
 *
 * Policy — refresh ONLY at launch. We deliberately do NOT re-seed on every Dexie
 * write: a single seed is a full rebuild of the whole vault, and a sync/import can
 * fire thousands of writes, so write-triggered reseeds would thrash the engine and
 * never converge. Mid-session drift is handled by the per-screen freshness gate
 * (evaluateEngineFreshness), which simply falls back to Dexie until the next launch
 * re-seeds. A failed/ERROR engine is left as-is (no retry loop); screens fall back
 * to Dexie.
 *
 * The bootstrap exposes a small subscribable state so a global header indicator can
 * show "Preparing fast mode…" while a background seed runs, and also publishes an
 * ActivityBus task so the activity monitor reflects it.
 */
import {
  isEngineAvailable,
  ensureEngineInit,
  getEngineStatus,
  seedAll,
  engineSeedInFlight,
  subscribeFinalizeProgress,
  type SeedProgress,
  type FinalizeProgress,
  type SeedResult,
} from './engine-client';
import { evaluateEngineFreshness } from './engine-freshness';
import { getActivityBus } from '@/lib/activity-bus';

export type EngineMaintenancePhase =
  | 'idle'
  | 'checking'
  | 'seeding'
  | 'refreshing'
  | 'ready'
  | 'error';

export interface EngineMaintenanceState {
  phase: EngineMaintenancePhase;
  /** Streaming seed progress while phase is 'seeding' | 'refreshing'. */
  progress?: SeedProgress;
  /** Pushed finalize-phase progress (index build → materialize → integrity). */
  finalize?: FinalizeProgress;
  message?: string;
}

const ACTIVITY_ID = 'engine-bootstrap';

let state: EngineMaintenanceState = { phase: 'idle' };
const listeners = new Set<(s: EngineMaintenanceState) => void>();

function setState(patch: Partial<EngineMaintenanceState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => {
    try {
      listener(state);
    } catch {
      // A misbehaving listener must not break the others.
    }
  });
}

export function getEngineMaintenanceState(): EngineMaintenanceState {
  return state;
}

/**
 * Subscribe to maintenance-state changes. Fires once immediately with the current
 * state, then on every transition. Returns an unsubscribe function.
 */
export function subscribeEngineMaintenance(
  listener: (s: EngineMaintenanceState) => void,
): () => void {
  listeners.add(listener);
  try {
    listener(state);
  } catch {
    // ignore
  }
  return () => {
    listeners.delete(listener);
  };
}

let bootstrapStarted = false;

/**
 * Kick off the launch bootstrap exactly once per app session. Safe to call from a
 * mount effect that can run more than once — only the first call does anything.
 * A no-op (engine never touched) in the browser preview.
 */
export function startEngineBootstrapOnce(): void {
  if (bootstrapStarted) return;
  bootstrapStarted = true;
  if (!isEngineAvailable()) return;
  void runBootstrap();
}

/** Drive a (re)seed, mirroring its progress into both the state and ActivityBus. */
async function runSeed(phase: 'seeding' | 'refreshing'): Promise<void> {
  const bus = getActivityBus();
  setState({
    phase,
    progress: undefined,
    finalize: undefined,
    message: phase === 'refreshing' ? 'Refreshing fast mode…' : 'Preparing fast mode…',
  });
  bus.publishTask({
    id: ACTIVITY_ID,
    label: 'Preparing fast mode',
    phase: 'Building',
    current: 0,
    total: 0,
  });
  // Finalize progress is pushed from the worker even while it is busy in the
  // synchronous finalize, so subscribe for it independently of seed batches.
  const unsubFinalize = subscribeFinalizeProgress((fp) => {
    setState({ finalize: fp });
    bus.publishTask({
      id: ACTIVITY_ID,
      label: 'Preparing fast mode',
      phase: fp.label,
      current: fp.step,
      total: fp.totalSteps,
    });
  });
  try {
    const results: SeedResult[] = await seedAll((p) => {
      setState({ progress: p });
      bus.publishTask({
        id: ACTIVITY_ID,
        label: 'Preparing fast mode',
        phase: p.table,
        current: p.overallProcessed,
        total: p.overallTotal,
      });
    });
    // A cancelled seed leaves the engine EMPTY (clear() aborts it), so don't claim
    // "ready" — screens correctly fall back to Dexie.
    const cancelled = results.some((r) => r.cancelled);
    setState({
      phase: cancelled ? 'idle' : 'ready',
      progress: undefined,
      finalize: undefined,
      message: undefined,
    });
  } catch {
    setState({
      phase: 'error',
      progress: undefined,
      finalize: undefined,
      message: 'Fast mode unavailable',
    });
  } finally {
    unsubFinalize();
    bus.completeTask(ACTIVITY_ID);
  }
}

async function runBootstrap(): Promise<void> {
  try {
    setState({ phase: 'checking', message: 'Checking fast mode…' });
    await ensureEngineInit();

    // A seed is already streaming (e.g. a manual Diagnostics seed kicked off just
    // before us). seedAll is locked, so calling it just attaches to that run.
    if (engineSeedInFlight()) {
      await runSeed('seeding');
      return;
    }

    const snap = await getEngineStatus();

    // A prior seed failed. Do NOT auto-retry on launch (avoid a reseed loop);
    // screens fall back to Dexie. Surface it once.
    if (snap.state === 'ERROR') {
      setState({ phase: 'error', message: 'Fast mode unavailable' });
      return;
    }

    // Never seeded for this vault → build it.
    if (snap.state === 'EMPTY') {
      await runSeed('seeding');
      return;
    }

    // Mirror exists and is indexed → confirm it still matches the live vault.
    // Refresh exactly once this session ONLY if it has genuinely drifted ('stale').
    // A transient fingerprint read failure ('error') must NOT trigger a rebuild:
    // tearing down a valid, indexed mirror over a flaky probe is strictly worse
    // than keeping it — screens already re-check freshness per read and fall back
    // to Dexie on their own if needed.
    if (snap.state === 'READY') {
      const decision = await evaluateEngineFreshness('allMirrors');
      if (decision.useEngine) {
        setState({ phase: 'ready', message: undefined });
        return;
      }
      if (decision.reason === 'stale') {
        await runSeed('refreshing');
        return;
      }
      // Couldn't verify (error/not-ready): leave the existing mirror intact.
      setState({ phase: 'idle', message: undefined });
      return;
    }

    // LOADING / INDEXING without our lock is not reachable at launch (the worker
    // starts EMPTY or READY in a fresh process). Settle to idle and let the
    // per-screen readiness subscriptions pick up the fast path if it appears.
    setState({ phase: 'idle', message: undefined });
  } catch {
    setState({ phase: 'error', message: 'Fast mode unavailable' });
  }
}
