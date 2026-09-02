// @vitest-environment jsdom
//
// Tests for the shared clickSaveButton helper. These prove the helper actually
// catches the regressions it is meant to guard against — a Save button moved
// outside its <form>, a button that loses type="submit", and a form that cannot
// submit because a required field is empty — so editor tests can click the real
// Save button with confidence.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { clickSaveButton } from "@/test/clickSave";

afterEach(() => {
  cleanup();
});

describe("clickSaveButton", () => {
  it("clicks a properly wired submit button and triggers the form's submit", () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <input data-testid="input-label" defaultValue="filled" required />
        <button type="submit" data-testid="button-save">
          Save
        </button>
      </form>,
    );

    clickSaveButton();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("throws when the Save button is not type=submit (regression: wrong type)", () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <button type="button" data-testid="button-save">
          Save
        </button>
      </form>,
    );

    expect(() => clickSaveButton()).toThrow(/type="submit"/);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("throws when the Save button is outside any <form> (regression: moved out)", () => {
    render(
      <div>
        <form>
          <input data-testid="input-label" defaultValue="filled" required />
        </form>
        <button type="submit" data-testid="button-save">
          Save
        </button>
      </div>,
    );

    expect(() => clickSaveButton()).toThrow(/not inside .*<form>/);
  });

  it("throws a clear error naming the empty required field instead of silently not submitting", () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <input data-testid="input-label" defaultValue="" required />
        <button type="submit" data-testid="button-save">
          Save
        </button>
      </form>,
    );

    expect(() => clickSaveButton()).toThrow(/constraint validation[\s\S]*input-label/);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("clicks an intentionally-invalid form when expectValid is false", () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <input data-testid="input-label" defaultValue="" required />
        <button type="submit" data-testid="button-save">
          Save
        </button>
      </form>,
    );

    // Does not throw; the empty required field means the browser/jsdom blocks the
    // submit, which is the behavior under test.
    expect(() => clickSaveButton({ expectValid: false })).not.toThrow();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("button-save")).toBeTruthy();
  });
});
