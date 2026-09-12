// @vitest-environment jsdom
//
// Task: confirm removing a trusted (TOFU-pinned) Electrum certificate
// re-prompts the verification dialog on the next connection test.
//
// Drives the real NodeSettings page end-to-end at the component level:
// 1. The pinned-cert panel (panel-electrum-pinned-cert) is visible for a
//    server that has a pinned certificate.
// 2. Clicking "Remove trust" (button-revoke-electrum-cert) calls the
//    electrum-revoke-certificate IPC and the panel disappears.
// 3. Running "Test Electrum Connection" afterwards gets CERT_UNTRUSTED from
//    the (now trust-less) main process and the page surfaces the TOFU
//    fingerprint dialog (dialog-electrum-cert-trust) again instead of a
//    plain error toast.
//
// The Electron IPC bridge is replaced by a stateful stub that models the
// main-process trust store the same way electron/electrum-client.cjs does:
// revoke clears the pin, and a test connection with no pin fails with
// CERT_UNTRUSTED + certificate details. Everything else (page state, refresh
// counter, dialog rendering) is the real component logic.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Radix Slider (request-timeout control) mounts a ResizeObserver; jsdom has none.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;

import { screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-toast")>();
  return {
    ...actual,
    useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
  };
});

// Node settings: point the page at an SSL Electrum server so the pinned-cert
// panel and test-connection flow target a stable host:port. The hook's Dexie
// plumbing is irrelevant here.
vi.mock("@/hooks/use-node-settings", () => ({
  useNodeSettings: () => ({
    nodeSettings: {
      id: "default",
      providerType: "mempool-space",
      useTor: false,
      requestTimeout: 30000,
      network: "mainnet",
      allowLocalNetwork: false,
      trustedLocalHosts: [],
      useElectrum: true,
      electrumHost: "electrum.example.test",
      electrumPort: 50002,
      electrumSSL: true,
      electrumServerType: "electrs",
    },
    updateSettings: vi.fn().mockResolvedValue(undefined),
    resetToDefaults: vi.fn(),
    isLoading: false,
  }),
}));

// Stateful stub of the Electron IPC bridge (see file header).
const CERT = {
  fingerprint: "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
  subject: "CN=electrum.example.test",
  issuer: "CN=electrum.example.test",
  validFrom: "Jan 1 00:00:00 2026 GMT",
  validTo: "Jan 1 00:00:00 2027 GMT",
  selfSigned: true,
};

const trustStore = vi.hoisted(() => ({
  pinned: null as null | Record<string, unknown>,
}));

const electrumTestSpy = vi.hoisted(() => vi.fn());
const revokeSpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/electron", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/electron")>();
  return {
    ...actual,
    isElectron: () => true,
    getElectronAPI: () => ({
      electrumGetCertificateTrust: async (_params: unknown) => ({
        success: true,
        pinned: trustStore.pinned,
      }),
      electrumRevokeCertificate: async (params: unknown) => {
        revokeSpy(params);
        const hadPin = trustStore.pinned !== null;
        trustStore.pinned = null;
        return { success: true, revoked: hadPin };
      },
      electrumTest: async (params: unknown) => {
        electrumTestSpy(params);
        if (trustStore.pinned) {
          return { success: true, serverVersion: "electrs 0.10", blockHeight: 900000, transport: "direct" };
        }
        return {
          success: false,
          error: "Certificate is not trusted",
          errorCode: "CERT_UNTRUSTED",
          certificate: { ...CERT },
        };
      },
      electrumTrustCertificate: async () => ({ success: true }),
    }),
  };
});

import { renderWithProviders } from "@/test/testProviders";
import NodeSettings from "@/pages/NodeSettings";

describe("NodeSettings — revoking a pinned certificate re-prompts the TOFU dialog", () => {
  beforeEach(() => {
    trustStore.pinned = {
      ...CERT,
      trustedAt: new Date("2026-08-01T00:00:00Z").getTime(),
    };
    toastSpy.mockClear();
    electrumTestSpy.mockClear();
    revokeSpy.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the pinned panel, removes it on revoke, and re-surfaces the trust prompt on the next test", async () => {
    renderWithProviders(<NodeSettings />);

    // 1. Pinned-cert panel is visible with the pinned fingerprint.
    await waitFor(() => {
      expect(screen.getByTestId("panel-electrum-pinned-cert")).toBeTruthy();
    });
    expect(
      screen.getByTestId("text-pinned-cert-fingerprint").textContent,
    ).toBe(CERT.fingerprint);

    // 2. Revoke: IPC is called with the configured host/port and the panel
    // disappears (refresh re-query returns no pin).
    fireEvent.click(screen.getByTestId("button-revoke-electrum-cert"));

    await waitFor(() => {
      expect(revokeSpy).toHaveBeenCalledWith({
        host: "electrum.example.test",
        port: 50002,
      });
      expect(screen.queryByTestId("panel-electrum-pinned-cert")).toBeNull();
    });
    expect(
      toastSpy.mock.calls.some(([arg]) => arg?.title === "Trust Removed"),
    ).toBe(true);

    // 3. Test the connection again: the trust store no longer has the pin,
    // so the stub main process returns CERT_UNTRUSTED and the page must show
    // the TOFU fingerprint dialog (not just an error toast).
    fireEvent.click(screen.getByTestId("button-test-electrum"));

    await waitFor(() => {
      expect(screen.getByTestId("dialog-electrum-cert-trust")).toBeTruthy();
    });
    // The dialog shows the certificate fingerprint for out-of-band
    // verification, plus explicit trust/reject actions.
    expect(electrumTestSpy).toHaveBeenCalledTimes(1);
    const dialog = screen.getByTestId("dialog-electrum-cert-trust");
    expect(dialog.textContent).toContain(CERT.fingerprint);
    expect(screen.getByTestId("button-electrum-cert-trust")).toBeTruthy();
    expect(screen.getByTestId("button-electrum-cert-reject")).toBeTruthy();
  });

  it("keeps the panel and skips the prompt when revoke fails", async () => {
    renderWithProviders(<NodeSettings />);
    await waitFor(() => {
      expect(screen.getByTestId("panel-electrum-pinned-cert")).toBeTruthy();
    });

    // Make the revoke IPC fail without touching the trust store.
    revokeSpy.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    // The stub above throws from the spy inside electrumRevokeCertificate,
    // which rejects the async handler — the page must toast a failure and
    // keep the pinned panel.
    fireEvent.click(screen.getByTestId("button-revoke-electrum-cert"));

    await waitFor(() => {
      expect(
        toastSpy.mock.calls.some(([arg]) => arg?.title === "Revoke Failed"),
      ).toBe(true);
    });
    expect(screen.getByTestId("panel-electrum-pinned-cert")).toBeTruthy();
    expect(trustStore.pinned).not.toBeNull();
  });
});
