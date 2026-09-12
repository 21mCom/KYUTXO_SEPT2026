// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  ActivityBusProvider,
  useActivityBus,
  getActivityBus,
} from './activity-bus';

const MONITOR_ENABLED_KEY = 'activity-monitor-enabled';

function wrapper({ children }: { children: ReactNode }) {
  return <ActivityBusProvider>{children}</ActivityBusProvider>;
}

beforeEach(() => {
  localStorage.clear();
});

describe('ActivityBusProvider - publishTask', () => {
  it('creates a new task and emits a start event', () => {
    const { result } = renderHook(() => useActivityBus(), { wrapper });

    act(() => {
      result.current.publishTask({ id: 't1', label: 'Sync', phase: 'init', current: 0, total: 100 });
    });

    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0]).toMatchObject({
      id: 't1',
      label: 'Sync',
      phase: 'init',
      current: 0,
      total: 100,
    });
    expect(result.current.tasks[0].startedAt).toBeGreaterThan(0);
    expect(result.current.tasks[0].lastProgressAt).toBeGreaterThan(0);

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]).toMatchObject({
      kind: 'start',
      label: 'Sync',
      message: 'Started: Sync',
    });
  });

  it('updates an existing task on subsequent publish with same id', () => {
    const { result } = renderHook(() => useActivityBus(), { wrapper });

    act(() => {
      result.current.publishTask({ id: 't1', label: 'Sync', phase: 'init', current: 0, total: 100 });
    });
    act(() => {
      result.current.publishTask({ id: 't1', label: 'Sync', phase: 'init', current: 50, total: 100 });
    });

    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0].current).toBe(50);
    // Only the start event - count-only updates should NOT add events
    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0].kind).toBe('start');
  });

  it('emits a progress event on phase transition', () => {
    const { result } = renderHook(() => useActivityBus(), { wrapper });

    act(() => {
      result.current.publishTask({ id: 't1', label: 'Sync', phase: 'init', current: 0, total: 100 });
    });
    act(() => {
      result.current.publishTask({ id: 't1', label: 'Sync', phase: 'fetching', current: 10, total: 100 });
    });

    expect(result.current.tasks[0].phase).toBe('fetching');
    expect(result.current.events).toHaveLength(2);
    // Newest event first
    expect(result.current.events[0]).toMatchObject({
      kind: 'progress',
      label: 'Sync',
      message: 'Sync: fetching',
    });
    expect(result.current.events[1].kind).toBe('start');
  });
});

describe('ActivityBusProvider - completeTask', () => {
  it('removes the task and emits a complete event', () => {
    const { result } = renderHook(() => useActivityBus(), { wrapper });

    act(() => {
      result.current.publishTask({ id: 't1', label: 'Sync', phase: 'init', current: 0, total: 100 });
    });
    act(() => {
      result.current.completeTask('t1');
    });

    expect(result.current.tasks).toHaveLength(0);
    expect(result.current.events).toHaveLength(2);
    expect(result.current.events[0]).toMatchObject({
      kind: 'complete',
      label: 'Sync',
      message: 'Completed: Sync',
    });
  });

  it('does nothing when completing an unknown task id', () => {
    const { result } = renderHook(() => useActivityBus(), { wrapper });

    act(() => {
      result.current.completeTask('does-not-exist');
    });

    expect(result.current.tasks).toHaveLength(0);
    expect(result.current.events).toHaveLength(0);
  });
});

describe('ActivityBusProvider - event log cap', () => {
  it('caps events at 50 entries, keeping the most recent', () => {
    const { result } = renderHook(() => useActivityBus(), { wrapper });

    act(() => {
      for (let i = 0; i < 60; i++) {
        result.current.pushEvent({
          kind: 'info',
          label: `lbl-${i}`,
          message: `msg-${i}`,
        });
      }
    });

    expect(result.current.events).toHaveLength(50);
    // Newest first
    expect(result.current.events[0].message).toBe('msg-59');
    expect(result.current.events[49].message).toBe('msg-10');
  });
});

describe('ActivityBusProvider - watchdog stuck detection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks isStuck true when a task has no progress for >15s', () => {
    const { result } = renderHook(() => useActivityBus(), { wrapper });

    act(() => {
      result.current.publishTask({ id: 't1', label: 'Sync', phase: 'init', current: 0, total: 100 });
    });
    expect(result.current.isStuck).toBe(false);

    // Advance past the 15s threshold; watchdog runs every 2s
    act(() => {
      vi.advanceTimersByTime(16_000);
    });

    expect(result.current.isStuck).toBe(true);
  });

  it('does not mark isStuck when progress is recent', () => {
    const { result } = renderHook(() => useActivityBus(), { wrapper });

    act(() => {
      result.current.publishTask({ id: 't1', label: 'Sync', phase: 'init', current: 0, total: 100 });
    });

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(result.current.isStuck).toBe(false);
  });

  it('clears isStuck after the task completes', () => {
    const { result } = renderHook(() => useActivityBus(), { wrapper });

    act(() => {
      result.current.publishTask({ id: 't1', label: 'Sync', phase: 'init', current: 0, total: 100 });
    });
    act(() => {
      vi.advanceTimersByTime(16_000);
    });
    expect(result.current.isStuck).toBe(true);

    act(() => {
      result.current.completeTask('t1');
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(result.current.isStuck).toBe(false);
  });
});

describe('ActivityBusProvider - monitorEnabled localStorage persistence', () => {
  it('defaults to true when no value is stored', () => {
    const { result } = renderHook(() => useActivityBus(), { wrapper });
    expect(result.current.monitorEnabled).toBe(true);
  });

  it('reads "false" from localStorage on init', () => {
    localStorage.setItem(MONITOR_ENABLED_KEY, 'false');
    const { result } = renderHook(() => useActivityBus(), { wrapper });
    expect(result.current.monitorEnabled).toBe(false);
  });

  it('reads "true" from localStorage on init', () => {
    localStorage.setItem(MONITOR_ENABLED_KEY, 'true');
    const { result } = renderHook(() => useActivityBus(), { wrapper });
    expect(result.current.monitorEnabled).toBe(true);
  });

  it('persists changes via setMonitorEnabled', () => {
    const { result } = renderHook(() => useActivityBus(), { wrapper });

    act(() => {
      result.current.setMonitorEnabled(false);
    });
    expect(result.current.monitorEnabled).toBe(false);
    expect(localStorage.getItem(MONITOR_ENABLED_KEY)).toBe('false');

    act(() => {
      result.current.setMonitorEnabled(true);
    });
    expect(result.current.monitorEnabled).toBe(true);
    expect(localStorage.getItem(MONITOR_ENABLED_KEY)).toBe('true');
  });
});

describe('getActivityBus global accessor', () => {
  it('forwards calls to the mounted provider', () => {
    const { result } = renderHook(() => useActivityBus(), { wrapper });

    act(() => {
      getActivityBus().publishTask({ id: 'g1', label: 'Global', phase: 'init', current: 0, total: 1 });
    });
    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0].id).toBe('g1');

    act(() => {
      getActivityBus().pushEvent({ kind: 'info', label: 'global-evt', message: 'hi' });
    });
    expect(result.current.events[0].message).toBe('hi');

    act(() => {
      getActivityBus().completeTask('g1');
    });
    expect(result.current.tasks).toHaveLength(0);
  });

  it('is a no-op when no provider is mounted', () => {
    const { unmount } = render(
      <ActivityBusProvider>
        <span />
      </ActivityBusProvider>,
    );
    unmount();

    expect(() => {
      getActivityBus().publishTask({ id: 'x', label: 'x', phase: 'p', current: 0, total: 0 });
      getActivityBus().completeTask('x');
      getActivityBus().pushEvent({ kind: 'info', label: 'x', message: 'x' });
    }).not.toThrow();
  });
});
