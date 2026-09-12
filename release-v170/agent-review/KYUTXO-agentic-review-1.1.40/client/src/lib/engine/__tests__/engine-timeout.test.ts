import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  withEngineTimeout,
  EngineProbeTimeoutError,
  ENGINE_PROBE_TIMEOUT_MS,
} from '../engine-timeout';

afterEach(() => {
  vi.useRealTimers();
});

describe('withEngineTimeout', () => {
  it('resolves with the probe value when it settles before the bound', async () => {
    await expect(withEngineTimeout(Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('propagates the underlying rejection (not a timeout) when the probe rejects first', async () => {
    const boom = new Error('probe failed');
    await expect(withEngineTimeout(Promise.reject(boom))).rejects.toBe(boom);
  });

  it('rejects with EngineProbeTimeoutError when the probe never settles in time', async () => {
    vi.useFakeTimers();
    // A probe that never resolves — mimics the worker blocked in seed finalize.
    const stalled = new Promise<string>(() => {});
    const raced = withEngineTimeout(stalled, 2000);
    const assertion = expect(raced).rejects.toBeInstanceOf(EngineProbeTimeoutError);
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
  });

  it('defaults the bound to ENGINE_PROBE_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    const stalled = new Promise<string>(() => {});
    const raced = withEngineTimeout(stalled);
    const assertion = expect(raced).rejects.toBeInstanceOf(EngineProbeTimeoutError);
    await vi.advanceTimersByTimeAsync(ENGINE_PROBE_TIMEOUT_MS);
    await assertion;
  });
});
