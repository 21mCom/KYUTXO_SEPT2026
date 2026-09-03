import "fake-indexeddb/auto";

// jsdom intentionally omits layout APIs. Radix and the virtualizer use
// ResizeObserver for measurement, so suites that render those components need
// a deterministic stand-in rather than failing only when the full suite happens
// to reach a newly upgraded primitive. Individual tests can still replace this
// with a callback-driving observer when they need to assert measurements.
if (typeof globalThis.ResizeObserver === "undefined") {
  class TestResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  globalThis.ResizeObserver = TestResizeObserver;
}