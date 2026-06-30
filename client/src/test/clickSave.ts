// Shared helper for clicking the record editor's Save button in jsdom tests.
//
// Why this exists: the record form (RecordFormDialog) saves via an implicit
// form submission — the Save button is a `type="submit"` control inside the
// <form>, and clicking it relies on the browser dispatching a submit event.
// Tests used to side-step this by firing a `submit` event on the <form> element
// directly. That works, but it does NOT exercise the button's submit wiring, so
// it cannot catch a regression where the Save button gets moved outside the
// <form>, loses `type="submit"`, or is otherwise disconnected from the save flow.
//
// Two jsdom subtleties bit us repeatedly and this helper turns both into clear,
// actionable failures instead of confusing downstream timeouts:
//
//   1. Implicit submission only happens for a `type="submit"` button that lives
//      inside a <form>. If a regression breaks that wiring, clicking does
//      nothing and the test fails far away (e.g. waiting for a record that never
//      saved). We assert the wiring up-front with a descriptive error.
//
//   2. jsdom (like a real browser) runs HTML5 constraint validation on implicit
//      submission. If a `required` field (the editor's Label / address input) is
//      empty, the click is silently swallowed and the form never submits. We
//      check `form.checkValidity()` and, when it fails, throw an error naming the
//      offending controls so the test author knows to fill them first.
//
// Use `clickSaveButton()` instead of `fireEvent.submit(form)` so editor tests
// genuinely cover "clicking Save saves the record".

import { fireEvent, screen, within } from "@testing-library/react";

export interface ClickSaveOptions {
  /** data-testid of the save button. Defaults to "button-save". */
  testId?: string;
  /** Scope the lookup to a container instead of the whole document. */
  container?: HTMLElement;
  /**
   * When true (the default) the form must pass HTML5 constraint validation
   * before clicking, or a descriptive error is thrown. Set to false to click a
   * Save button on a deliberately-invalid form (e.g. asserting the editor blocks
   * submission while a required field is empty).
   */
  expectValid?: boolean;
}

function describeInvalidControls(form: HTMLFormElement): string {
  const invalid: string[] = [];
  const elements = Array.from(form.elements) as Array<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >;
  for (const el of elements) {
    if (typeof el.checkValidity === "function" && !el.checkValidity()) {
      const id =
        el.getAttribute("data-testid") ||
        el.getAttribute("name") ||
        el.id ||
        el.tagName.toLowerCase();
      invalid.push(`${id} (${el.validationMessage || "invalid"})`);
    }
  }
  return invalid.length > 0 ? invalid.join(", ") : "unknown control(s)";
}

/**
 * Click the record editor's Save button, asserting it is genuinely wired to
 * submit its form. Returns the clicked button element.
 */
export function clickSaveButton(options: ClickSaveOptions = {}): HTMLButtonElement {
  const { testId = "button-save", container, expectValid = true } = options;

  const scope = container ? within(container) : screen;
  const button = scope.getByTestId(testId) as HTMLButtonElement;

  const type = button.getAttribute("type");
  if (type !== "submit") {
    throw new Error(
      `clickSaveButton: the Save button [data-testid="${testId}"] must have ` +
        `type="submit" to trigger the form save, but its type is ` +
        `"${type ?? "(none)"}". A regression likely changed the button type or ` +
        `replaced it with a non-submit button, so clicking Save no longer saves.`,
    );
  }

  const form = button.closest("form");
  if (!form) {
    throw new Error(
      `clickSaveButton: the Save button [data-testid="${testId}"] is not inside ` +
        `a <form>, so clicking it cannot submit the record editor. A regression ` +
        `likely moved the button outside the <form>.`,
    );
  }

  if (expectValid && typeof form.checkValidity === "function" && !form.checkValidity()) {
    throw new Error(
      `clickSaveButton: the form failed HTML5 constraint validation, so ` +
        `clicking Save will be silently swallowed (no submit) — exactly as it ` +
        `would be in a real browser. Fill the required field(s) before clicking ` +
        `Save: ${describeInvalidControls(form)}. (Pass { expectValid: false } if ` +
        `you are intentionally testing that an invalid form blocks saving.)`,
    );
  }

  fireEvent.click(button);
  return button;
}
