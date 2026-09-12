// @vitest-environment jsdom
//
// Guards the QR Scanner page's SCANNED-DATA "Copy to Clipboard" button
// (testid button-copy-scanned). This button only renders after a successful
// camera scan sets the internal `scannedData` state, so we drive the real
// camera scan path: jsQR is stubbed to return a decoded address, the camera
// APIs (getUserMedia, canvas 2d context, video readiness, requestAnimationFrame)
// are stubbed so scanFrame runs once, detects a code, and surfaces the copy
// button. We then assert it writes the extracted address to the clipboard and
// fires the success / destructive "Copy failed" toast (NOT the unrelated
// "QR Code Detected" toast). The separate generator button is covered by
// client/src/pages/__tests__/copy-button-toast-qr.test.tsx.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
  waitFor,
} from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

vi.mock("jsqr", () => ({ default: vi.fn(() => ({ data: ADDRESS })) }));
vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,AAAA") },
}));

import QRScanner from "@/pages/QRScanner";

let writeText: ReturnType<typeof vi.fn>;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });

  // Camera stream stub.
  Object.defineProperty(navigator, "mediaDevices", {
    value: {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [],
      }),
    },
    configurable: true,
    writable: true,
  });

  // Canvas 2d context stub so scanFrame can draw + read pixels.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    drawImage: vi.fn(),
    getImageData: () => ({
      data: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
    }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

  // Video readiness: HAVE_ENOUGH_DATA is a built-in constant === 4. scanFrame
  // checks video.readyState !== video.HAVE_ENOUGH_DATA before processing a frame.
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
    configurable: true,
    get: () => 4,
  });
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", {
    configurable: true,
    get: () => 1,
  });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
    configurable: true,
    get: () => 1,
  });
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());

  // requestAnimationFrame invokes its callback synchronously. jsQR returns a
  // code on the first frame, which stops rescheduling (no infinite recursion).
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function scanAndReveal() {
  render(<QRScanner />);
  fireEvent.click(screen.getByTestId("button-start-scan"));
  await flush();
  await waitFor(() => screen.getByTestId("button-copy-scanned"), {
    timeout: 2000,
  });
}

describe("QRScanner scanned-data 'Copy to Clipboard' button toast", () => {
  it("copies the scanned address and shows the success toast", async () => {
    await scanAndReveal();
    toastMock.mockClear();

    fireEvent.click(screen.getByTestId("button-copy-scanned"));
    // copyAddress resolves the vault metadata lookup before delegating to the
    // clipboard helper.  That lookup is genuinely asynchronous (and can take
    // more than two microtask turns under fake IndexedDB), so wait for the
    // observable clipboard contract rather than assuming it has completed.
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ADDRESS), {
      timeout: 2000,
    });

    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Address copied",
      }),
    );
  });

  it("shows the destructive 'Copy failed' toast when the clipboard write rejects", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    await scanAndReveal();
    toastMock.mockClear();

    fireEvent.click(screen.getByTestId("button-copy-scanned"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ADDRESS), {
      timeout: 2000,
    });

    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Copy failed",
        description: "Could not copy the address to your clipboard.",
        variant: "destructive",
      }),
    );
  });
});
