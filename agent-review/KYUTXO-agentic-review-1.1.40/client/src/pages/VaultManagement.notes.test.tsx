// @vitest-environment jsdom
//
// Verifies the Vault Management page renders http(s) URLs found in vault
// `userNotes` and per-cosigner `notes` as click-only links via the shared
// renderSourceNote util. Upholds the offline-first guarantee: a URL is only ever
// opened on an explicit user click (window.open) and is NEVER fetched merely by
// rendering. Plain text notes (no URL) render without a link. Clicking a link
// inside the editable vault note must not enter edit mode (stopPropagation).
//
// We render the REAL VaultManagement page but stub the data-fetching chain
// (engine freshness/client + the Dexie record-crud lookup, toast, router) so the
// test exercises the page's actual notes markup rather than a replica.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  fireEvent,
  cleanup,
  within,
  waitFor,
} from "@testing-library/react";
import { fetchCallsWithNoteUrl } from "@/test/noteFetchCalls";

const VAULT_NOTE_URL = "https://example.com/vault-recovery";
const COSIGNER_NOTE_URL = "https://cosigner.example.org/alice";

let vaultNotes = "";

vi.mock("wouter", () => ({
  useLocation: () => ["/vaults", vi.fn()],
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/lib/dataFacade", () => ({
  updateRecord: vi.fn(async () => {}),
}));

// Force the page down its Dexie fallback path (engine not used) so we control
// the records via the record-crud mock below.
vi.mock("@/lib/engine/engine-freshness", () => ({
  evaluateEngineFreshness: vi.fn(async () => ({ useEngine: false })),
}));

vi.mock("@/lib/engine/engine-client", () => ({
  subscribeEngineReadiness: vi.fn(() => () => {}),
  engineGetVaultSummaries: vi.fn(async () => []),
}));

vi.mock("@/lib/data/record-crud", () => ({
  getAddressRecordsByImportanceTiersFiltered: vi.fn(
    async (
      _tiers: unknown,
      filter: (r: Record<string, unknown>) => boolean,
    ) => {
      const record = {
        id: "rec1",
        type: "address",
        inputString: "bc1qexamplevaultaddress",
        addressImportance: "verified",
        vault: {
          isVaultXpub: true,
          vaultName: "Family Vault",
          m: 2,
          n: 3,
          vaultNotes,
        },
      } as Record<string, unknown>;
      return [record].filter(filter);
    },
  ),
}));

const VaultManagement = (await import("./VaultManagement")).default;

function makeVaultNotes(opts: { cosignerNote: string; userNotes: string }) {
  return JSON.stringify({
    scriptType: "P2WSH",
    cosigners: [
      {
        index: 0,
        name: "Alice",
        notes: opts.cosignerNote,
        xpubPreview: "xpub6ABCDEF",
      },
    ],
    userNotes: opts.userNotes,
  });
}

describe("VaultManagement notes link rendering (offline-first)", () => {
  let openSpy: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    fetchSpy = vi
      .fn()
      .mockRejectedValue(new Error("network access is forbidden"));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders a URL in vault-level notes as a click-only link and never fetches on load", async () => {
    vaultNotes = makeVaultNotes({
      cosignerNote: "Key held offline",
      userNotes: `Recovery steps ${VAULT_NOTE_URL} here`,
    });
    const { findByTestId } = render(<VaultManagement />);

    const notes = await findByTestId("text-vault-notes-0");
    const link = within(notes).getByRole("link");
    expect(link.getAttribute("href")).toBe(VAULT_NOTE_URL);
    expect(link.textContent).toBe(VAULT_NOTE_URL);
    expect(notes.textContent).toBe(`Recovery steps ${VAULT_NOTE_URL} here`);

    // Offline-first: the note URL is never fetched merely by rendering.
    // (Unrelated app-level background fetches may fire during mount, so we
    // assert on the note URLs rather than on fetch never being called.)
    expect(fetchCallsWithNoteUrl(fetchSpy, VAULT_NOTE_URL)).toEqual([]);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("opens the vault-note link via window.open only on click, without entering edit mode", async () => {
    vaultNotes = makeVaultNotes({
      cosignerNote: "Key held offline",
      userNotes: `See ${VAULT_NOTE_URL} for the steps`,
    });
    const { findByTestId, queryByTestId } = render(<VaultManagement />);

    const notes = await findByTestId("text-vault-notes-0");
    const link = within(notes).getByRole("link");

    expect(openSpy).not.toHaveBeenCalled();
    expect(fetchCallsWithNoteUrl(fetchSpy, VAULT_NOTE_URL)).toEqual([]);

    const clickEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link, clickEvent);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      VAULT_NOTE_URL,
      "_blank",
      "noopener,noreferrer",
    );
    expect(clickEvent.defaultPrevented).toBe(true);
    // The wrapping span stops propagation, so the click never opens edit mode.
    expect(queryByTestId("textarea-vault-notes-0")).toBeNull();
    // Opening is delegated to the browser, never fetched in-app.
    expect(fetchCallsWithNoteUrl(fetchSpy, VAULT_NOTE_URL)).toEqual([]);
  });

  it("renders a URL in a per-cosigner note as a click-only link and opens it via window.open on click", async () => {
    vaultNotes = makeVaultNotes({
      cosignerNote: `Profile ${COSIGNER_NOTE_URL} contact`,
      userNotes: "Plain vault note",
    });
    const { findByTestId, getByTestId } = render(<VaultManagement />);

    // Cosigner notes live inside a collapsible; expand it to render them.
    const toggle = await findByTestId("button-toggle-cosigners-0");
    fireEvent.click(toggle);

    const notes = await findByTestId("text-cosigner-notes-0-0");
    const link = within(notes).getByRole("link");
    expect(link.getAttribute("href")).toBe(COSIGNER_NOTE_URL);
    expect(link.textContent).toBe(COSIGNER_NOTE_URL);

    expect(fetchCallsWithNoteUrl(fetchSpy, COSIGNER_NOTE_URL)).toEqual([]);
    expect(openSpy).not.toHaveBeenCalled();

    fireEvent.click(getByTestId("text-cosigner-notes-0-0").querySelector("a")!);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      COSIGNER_NOTE_URL,
      "_blank",
      "noopener,noreferrer",
    );
    expect(fetchCallsWithNoteUrl(fetchSpy, COSIGNER_NOTE_URL)).toEqual([]);
  });

  it("wraps a very long unbroken URL (break-all) so it can't break the vault layout", async () => {
    const longUrl =
      "https://example.com/" + "a".repeat(400) + "/recovery-instructions";
    vaultNotes = makeVaultNotes({
      cosignerNote: `Key details ${longUrl} end`,
      userNotes: `Recovery ${longUrl} steps`,
    });
    const { findByTestId } = render(<VaultManagement />);

    const vaultNotesEl = await findByTestId("text-vault-notes-0");
    const vaultLink = within(vaultNotesEl).getByRole("link");
    expect(vaultLink.getAttribute("href")).toBe(longUrl);
    expect(vaultLink.classList.contains("break-all")).toBe(true);

    fireEvent.click(await findByTestId("button-toggle-cosigners-0"));
    const cosignerNotesEl = await findByTestId("text-cosigner-notes-0-0");
    const cosignerLink = within(cosignerNotesEl).getByRole("link");
    expect(cosignerLink.getAttribute("href")).toBe(longUrl);
    expect(cosignerLink.classList.contains("break-all")).toBe(true);

    expect(fetchCallsWithNoteUrl(fetchSpy, longUrl)).toEqual([]);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("renders plain notes text (no URL) without any link", async () => {
    vaultNotes = makeVaultNotes({
      cosignerNote: "Key held by a trusted family member",
      userNotes: "Cold storage backup kept in the safe",
    });
    const { findByTestId } = render(<VaultManagement />);

    const vaultNotesEl = await findByTestId("text-vault-notes-0");
    expect(within(vaultNotesEl).queryByRole("link")).toBeNull();
    expect(vaultNotesEl.textContent).toBe("Cold storage backup kept in the safe");

    fireEvent.click(await findByTestId("button-toggle-cosigners-0"));
    const cosignerNotesEl = await findByTestId("text-cosigner-notes-0-0");
    expect(within(cosignerNotesEl).queryByRole("link")).toBeNull();
    expect(cosignerNotesEl.textContent).toBe(
      "Key held by a trusted family member",
    );

    expect(
      fetchCallsWithNoteUrl(fetchSpy, VAULT_NOTE_URL, COSIGNER_NOTE_URL),
    ).toEqual([]);
    expect(openSpy).not.toHaveBeenCalled();
  });
});
