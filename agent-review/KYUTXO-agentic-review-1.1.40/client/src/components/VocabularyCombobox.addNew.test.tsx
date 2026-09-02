// @vitest-environment jsdom
//
// Fast, component-level regression for the shared VocabularyCombobox /
// VocabularyMultiSelect "Add new" entry (Task #2126).
//
// The wallet-name/owner/etc. pickers across Wallet Import and other flows all
// go through this one shared component. A one-word wording drift here
// ("Create \"x\"" vs. the rest of the app's "Add \"x\"" convention — see
// combobox-create-new-wording in agent memory) previously went unnoticed
// until two unrelated 30s browser-check timeouts surfaced it, because the
// only coverage was incidental to full end-to-end browser checks.
//
// This test renders the real component (no DOM/browser needed), types a new
// value, and asserts:
//   1. The create-new item has a stable, text-independent test id.
//   2. Its label reads exactly `Add "<value>"`.
//   3. Clicking it invokes ensureSelectableVocabularyEntry and onChange.
// It fails in well under a second if the wording or click wiring regresses,
// long before the browser-check suite would catch it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// Radix Popover/Command reach for APIs jsdom does not provide.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;
Element.prototype.scrollIntoView = vi.fn();
(Element.prototype as any).hasPointerCapture = vi.fn();
(Element.prototype as any).releasePointerCapture = vi.fn();
(Element.prototype as any).setPointerCapture = vi.fn();

const ensureSelectableVocabularyEntry = vi.fn();
vi.mock("@/lib/dataFacade", () => ({
  ensureSelectableVocabularyEntry: (...args: unknown[]) =>
    ensureSelectableVocabularyEntry(...args),
}));

import { VocabularyCombobox, VocabularyMultiSelect } from "./VocabularyCombobox";

const EXISTING_OPTIONS = [{ value: "Cold Wallet", label: "Cold Wallet" }];
const NEW_VALUE = "Brand New Wallet";

describe("VocabularyCombobox — Add new entry", () => {
  beforeEach(() => {
    ensureSelectableVocabularyEntry.mockReset();
    ensureSelectableVocabularyEntry.mockResolvedValue(NEW_VALUE);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the create-new item labeled Add "<value>" with a stable test id', async () => {
    render(
      <VocabularyCombobox
        fieldKey="walletName"
        value=""
        onChange={vi.fn()}
        options={EXISTING_OPTIONS}
        placeholder="Select wallet name"
        vocabularyKey="walletNames"
      />,
    );

    fireEvent.click(screen.getByTestId("combobox-value-walletName"));
    fireEvent.change(screen.getByTestId("input-combobox-walletName"), {
      target: { value: NEW_VALUE },
    });

    const createOption = await screen.findByTestId("option-create-new-walletName");
    expect(createOption.textContent).toContain(`Add "${NEW_VALUE}"`);
    expect(createOption.textContent).not.toContain("Create");
  });

  it("invokes ensureSelectableVocabularyEntry and onChange when the create-new item is clicked", async () => {
    const onChange = vi.fn();
    render(
      <VocabularyCombobox
        fieldKey="walletName"
        value=""
        onChange={onChange}
        options={EXISTING_OPTIONS}
        placeholder="Select wallet name"
        vocabularyKey="walletNames"
      />,
    );

    fireEvent.click(screen.getByTestId("combobox-value-walletName"));
    fireEvent.change(screen.getByTestId("input-combobox-walletName"), {
      target: { value: NEW_VALUE },
    });

    const createOption = await screen.findByTestId("option-create-new-walletName");
    fireEvent.click(createOption);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(NEW_VALUE));
    expect(ensureSelectableVocabularyEntry).toHaveBeenCalledWith("walletName", NEW_VALUE);
  });

  it('does not show the create-new item for a value that already exists (case-insensitive)', () => {
    render(
      <VocabularyCombobox
        fieldKey="walletName"
        value=""
        onChange={vi.fn()}
        options={EXISTING_OPTIONS}
        placeholder="Select wallet name"
        vocabularyKey="walletNames"
      />,
    );

    fireEvent.click(screen.getByTestId("combobox-value-walletName"));
    fireEvent.change(screen.getByTestId("input-combobox-walletName"), {
      target: { value: "cold wallet" },
    });

    expect(screen.queryByTestId("option-create-new-walletName")).toBeNull();
  });
});

describe("VocabularyMultiSelect — Add new entry", () => {
  beforeEach(() => {
    ensureSelectableVocabularyEntry.mockReset();
    ensureSelectableVocabularyEntry.mockResolvedValue(NEW_VALUE);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the create-new item labeled Add "<value>" with a stable test id', async () => {
    render(
      <VocabularyMultiSelect
        fieldKey="owner"
        values={[]}
        onChange={vi.fn()}
        options={EXISTING_OPTIONS}
        placeholder="Select owners"
        vocabularyKey="owners"
      />,
    );

    fireEvent.click(screen.getByTestId("multiselect-filter-owner"));
    fireEvent.change(screen.getByTestId("multiselect-search-owner"), {
      target: { value: NEW_VALUE },
    });

    const createOption = await screen.findByTestId("multiselect-create-owner");
    expect(createOption.textContent).toContain(`Add "${NEW_VALUE}"`);
    expect(createOption.textContent).not.toContain("Create");
  });

  it("invokes ensureSelectableVocabularyEntry and onChange when the create-new item is clicked", async () => {
    const onChange = vi.fn();
    render(
      <VocabularyMultiSelect
        fieldKey="owner"
        values={[]}
        onChange={onChange}
        options={EXISTING_OPTIONS}
        placeholder="Select owners"
        vocabularyKey="owners"
      />,
    );

    fireEvent.click(screen.getByTestId("multiselect-filter-owner"));
    fireEvent.change(screen.getByTestId("multiselect-search-owner"), {
      target: { value: NEW_VALUE },
    });

    const createOption = await screen.findByTestId("multiselect-create-owner");
    fireEvent.click(createOption);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith([NEW_VALUE]));
    expect(ensureSelectableVocabularyEntry).toHaveBeenCalledWith("owner", NEW_VALUE);
  });
});
