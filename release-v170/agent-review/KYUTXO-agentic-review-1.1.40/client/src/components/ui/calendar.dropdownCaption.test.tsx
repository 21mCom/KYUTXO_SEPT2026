// @vitest-environment jsdom
//
// Guard test for the doubled month/year caption in the shared Calendar
// component (react-day-picker v8, captionLayout="dropdown-buttons"), as used
// by the UTXOs "View as of date..." picker.
//
// The bug: with dropdown-buttons, react-day-picker renders BOTH styled native
// <select> dropdowns AND the caption-label text, so the month/year appeared
// twice. The fix keeps the native selects functional but visually hidden as
// absolute overlays (opacity-0, inset-0, z-10) inside `relative` wrappers, so
// only the caption label + chevron icon are visible.
//
// The double-render itself is a browser-only *styling* bug (jsdom applies no
// CSS), so this test guards the mechanism instead: it asserts the classNames
// that make the selects invisible overlays are still wired to the select
// elements and their wrappers. If someone touches the shared calendar
// classNames (dropdown / dropdown_month / dropdown_year) and drops any of
// these, this test fails before the visual regression ships.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Calendar } from "@/components/ui/calendar";

afterEach(cleanup);

function classListOf(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

describe("Calendar dropdown-buttons caption overlay guard", () => {
  it("renders the month/year selects as invisible absolute overlays inside relative wrappers", () => {
    const { container } = render(
      <Calendar
        mode="single"
        captionLayout="dropdown-buttons"
        fromYear={2020}
        toYear={2026}
        defaultMonth={new Date(2024, 5, 15)}
      />
    );

    const selects = container.querySelectorAll("select");
    // dropdown-buttons renders exactly two native selects: month + year.
    expect(selects.length).toBe(2);

    for (const select of Array.from(selects)) {
      const classes = classListOf(select);
      // Invisible-overlay classes on the select itself.
      expect(classes).toContain("absolute");
      expect(classes).toContain("inset-0");
      expect(classes).toContain("opacity-0");

      // The select's wrapper (dropdown_month / dropdown_year) must establish a
      // positioning context, or the absolute select escapes its box.
      const wrapper = select.parentElement;
      expect(wrapper).not.toBeNull();
      expect(classListOf(wrapper!)).toContain("relative");
    }

    // The visible caption label (month + year text) must still be present —
    // it is what the user sees instead of the styled selects.
    const captionLabels = container.querySelectorAll(
      '[class*="text-sm"][class*="font-medium"]'
    );
    const labelTexts = Array.from(captionLabels)
      .map((el) => el.textContent ?? "")
      .filter((t) => /June/.test(t) && /2024/.test(t));
    expect(labelTexts.length).toBeGreaterThan(0);
  });

  it("leaves the default (non-dropdown) caption layout unchanged: no selects, plain caption label", () => {
    const { container } = render(
      <Calendar mode="single" defaultMonth={new Date(2024, 5, 15)} />
    );

    // Default caption layout has no native selects at all.
    expect(container.querySelectorAll("select").length).toBe(0);

    // The caption label shows the month/year exactly once.
    const matches = Array.from(container.querySelectorAll("*")).filter(
      (el) =>
        el.children.length === 0 &&
        /June\s*2024/.test(el.textContent ?? "")
    );
    expect(matches.length).toBe(1);
  });
});
