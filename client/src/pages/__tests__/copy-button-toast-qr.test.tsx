// @vitest-environment jsdom
//
// Guards the QR Scanner page's copy buttons (Task #538 wired their clipboard
// toasts). The QR generator's "Copy Text" button only appears once a QR code
// has been generated, so we stub the qrcode library to resolve a data URL
// synchronously and drive the textarea to surface the button. We then assert
// it writes the encoded text to the clipboard and fires the success / failure
// toast. jsQR is stubbed too since the page imports it at module load.
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

vi.mock("jsqr", () => ({ default: vi.fn(() => null) }));
vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,AAAA") },
}));

import QRScanner from "@/pages/QRScanner";

const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

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
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// The generator debounces input by 200ms before producing a data URL (which
// reveals the "Copy Text" button). Type into the textarea, then wait (real
// timers) for the debounce + mocked QR generation to mount the button.
async function showGeneratorCopyButton() {
  render(<QRScanner />);
  fireEvent.change(screen.getByTestId("input-qr-generator"), {
    target: { value: ADDRESS },
  });
  await waitFor(() => screen.getByTestId("button-copy-qr-text"), {
    timeout: 2000,
  });
}

describe("QRScanner generator 'Copy Text' button toast", () => {
  it("copies the encoded text and shows the success toast", async () => {
    await showGeneratorCopyButton();
    fireEvent.click(screen.getByTestId("button-copy-qr-text"));
    await flush();

    expect(writeText).toHaveBeenCalledWith(ADDRESS);
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Text copied to clipboard" }),
    );
  });

  it("shows the destructive 'Copy failed' toast when the clipboard write rejects", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    await showGeneratorCopyButton();
    fireEvent.click(screen.getByTestId("button-copy-qr-text"));
    await flush();

    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Copy failed", variant: "destructive" }),
    );
  });
});
