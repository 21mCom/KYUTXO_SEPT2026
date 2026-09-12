// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { ScrollPositionIndicator } from "./ScrollPositionIndicator";

const mockMatchMedia = vi.fn((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));

function createMockScrollElement(
  overrides: Partial<{
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
  }> = {},
): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollTop", {
    value: overrides.scrollTop ?? 0,
    writable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    value: overrides.clientHeight ?? 500,
    writable: true,
  });
  Object.defineProperty(el, "scrollHeight", {
    value: overrides.scrollHeight ?? 5000,
    writable: true,
  });
  return el;
}

const defaultVirtualItems = [
  { index: 0, start: 0, end: 50 },
  { index: 1, start: 50, end: 100 },
  { index: 2, start: 100, end: 150 },
];

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: mockMatchMedia,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ScrollPositionIndicator", () => {
  describe("variant CSS classes", () => {
    it("renders default variant classes when variant is omitted", () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={100}
          scrollElement={el}
        />,
      );

      const wrapper = container.querySelector('[data-testid="scroll-position-indicator"]')!;
      expect(wrapper).toBeTruthy();
      expect(wrapper.className).toContain("sticky");
      expect(wrapper.className).toContain("bottom-0");
      expect(wrapper.className).toContain("z-20");
      expect(wrapper.className).toContain("transition-opacity");

      const pill = wrapper.querySelector("span")!;
      expect(pill.className).toContain("bg-background/80");
      expect(pill.className).toContain("backdrop-blur-sm");
      expect(pill.className).toContain("px-3");
      expect(pill.className).toContain("py-1");
      expect(pill.className).toContain("text-xs");
    });

    it('renders default variant classes when variant="default"', () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={100}
          scrollElement={el}
          variant="default"
        />,
      );

      const wrapper = container.querySelector('[data-testid="scroll-position-indicator"]')!;
      expect(wrapper).toBeTruthy();

      const pill = wrapper.querySelector("span")!;
      expect(pill.className).toContain("bg-background/80");
      expect(pill.className).toContain("px-3");
      expect(pill.className).toContain("py-1");
      expect(pill.className).toContain("text-xs");
    });

    it('renders table variant classes when variant="table"', () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={100}
          scrollElement={el}
          variant="table"
        />,
      );

      const wrapper = container.querySelector('[data-testid="scroll-position-indicator"]')!;
      expect(wrapper).toBeTruthy();

      const pill = wrapper.querySelector("span")!;
      expect(pill.className).toContain("bg-muted/90");
      expect(pill.className).toContain("backdrop-blur-sm");
      expect(pill.className).toContain("px-3");
      expect(pill.className).toContain("py-1");
      expect(pill.className).toContain("text-xs");
      expect(pill.className).not.toContain("bg-background/80");
    });

    it('renders compact variant classes when variant="compact"', () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={100}
          scrollElement={el}
          variant="compact"
        />,
      );

      const wrapper = container.querySelector('[data-testid="scroll-position-indicator"]')!;
      expect(wrapper).toBeTruthy();
      expect(wrapper.className).toContain("py-0.5");

      const pill = wrapper.querySelector("span")!;
      expect(pill.className).toContain("bg-background/80");
      expect(pill.className).toContain("backdrop-blur-sm");
      expect(pill.className).toContain("px-2");
      expect(pill.className).toContain("py-0.5");
      expect(pill.className).toContain("text-[11px]");
      expect(pill.className).not.toContain("px-3");
      expect(pill.className).not.toContain("text-xs");
    });
  });

  describe("className merging", () => {
    it("merges custom className into the wrapper alongside default variant", () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={100}
          scrollElement={el}
          className="mt-4 custom-class"
        />,
      );

      const wrapper = container.querySelector('[data-testid="scroll-position-indicator"]')!;
      expect(wrapper.className).toContain("mt-4");
      expect(wrapper.className).toContain("custom-class");
      expect(wrapper.className).toContain("sticky");
      expect(wrapper.className).toContain("bottom-0");
    });

    it("merges custom className into the wrapper alongside table variant", () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={100}
          scrollElement={el}
          variant="table"
          className="mb-2"
        />,
      );

      const wrapper = container.querySelector('[data-testid="scroll-position-indicator"]')!;
      expect(wrapper.className).toContain("mb-2");
      expect(wrapper.className).toContain("sticky");
    });

    it("merges custom className into the wrapper alongside compact variant", () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={100}
          scrollElement={el}
          variant="compact"
          className="opacity-90"
        />,
      );

      const wrapper = container.querySelector('[data-testid="scroll-position-indicator"]')!;
      expect(wrapper.className).toContain("opacity-90");
      expect(wrapper.className).toContain("py-0.5");
    });

    it("allows className to override base wrapper classes via tailwind-merge", () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={100}
          scrollElement={el}
          className="z-50"
        />,
      );

      const wrapper = container.querySelector('[data-testid="scroll-position-indicator"]')!;
      expect(wrapper.className).toContain("z-50");
      expect(wrapper.className).not.toContain("z-20");
    });
  });

  describe("integration point configurations", () => {
    it("Transactions: default variant with label='transactions'", () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={200}
          scrollElement={el}
          label="transactions"
        />,
      );

      const wrapper = container.querySelector('[data-testid="scroll-position-indicator"]')!;
      expect(wrapper).toBeTruthy();

      const pill = wrapper.querySelector("span")!;
      expect(pill.textContent).toContain("transactions");
      expect(pill.className).toContain("bg-background/80");
      expect(pill.className).toContain("px-3");
      expect(pill.className).toContain("text-xs");
    });

    it("BitcoinFlowVisualizer: default variant with label='addresses'", () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={50}
          scrollElement={el}
          label="addresses"
        />,
      );

      const wrapper = container.querySelector('[data-testid="scroll-position-indicator"]')!;
      expect(wrapper).toBeTruthy();

      const pill = wrapper.querySelector("span")!;
      expect(pill.textContent).toContain("addresses");
      expect(pill.className).toContain("bg-background/80");
      expect(pill.className).toContain("px-3");
      expect(pill.className).toContain("text-xs");
    });

    it("UTXOs: table variant with label='rows'", () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={500}
          scrollElement={el}
          variant="table"
          label="rows"
        />,
      );

      const wrapper = container.querySelector('[data-testid="scroll-position-indicator"]')!;
      expect(wrapper).toBeTruthy();

      const pill = wrapper.querySelector("span")!;
      expect(pill.textContent).toContain("rows");
      expect(pill.className).toContain("bg-muted/90");
      expect(pill.className).toContain("px-3");
      expect(pill.className).toContain("text-xs");
    });

    it("QuickTagger: table variant with label='entries'", () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={300}
          scrollElement={el}
          variant="table"
          label="entries"
        />,
      );

      const wrapper = container.querySelector('[data-testid="scroll-position-indicator"]')!;
      expect(wrapper).toBeTruthy();

      const pill = wrapper.querySelector("span")!;
      expect(pill.textContent).toContain("entries");
      expect(pill.className).toContain("bg-muted/90");
    });

    it("BulkEditor (compact): compact variant with label='records'", () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={150}
          scrollElement={el}
          variant="compact"
          label="records"
        />,
      );

      const wrapper = container.querySelector('[data-testid="scroll-position-indicator"]')!;
      expect(wrapper).toBeTruthy();
      expect(wrapper.className).toContain("py-0.5");

      const pill = wrapper.querySelector("span")!;
      expect(pill.textContent).toContain("records");
      expect(pill.className).toContain("bg-background/80");
      expect(pill.className).toContain("px-2");
      expect(pill.className).toContain("text-[11px]");
    });

    it("BulkEditor (table): table variant with label='records'", () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={150}
          scrollElement={el}
          variant="table"
          label="records"
        />,
      );

      const wrapper = container.querySelector('[data-testid="scroll-position-indicator"]')!;
      expect(wrapper).toBeTruthy();

      const pill = wrapper.querySelector("span")!;
      expect(pill.textContent).toContain("records");
      expect(pill.className).toContain("bg-muted/90");
      expect(pill.className).toContain("px-3");
      expect(pill.className).toContain("text-xs");
    });

    it("DiscoveryTreeDialog: compact variant with label='records'", () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={75}
          scrollElement={el}
          variant="compact"
          label="records"
        />,
      );

      const wrapper = container.querySelector('[data-testid="scroll-position-indicator"]')!;
      expect(wrapper).toBeTruthy();
      expect(wrapper.className).toContain("py-0.5");

      const pill = wrapper.querySelector("span")!;
      expect(pill.textContent).toContain("records");
      expect(pill.className).toContain("px-2");
      expect(pill.className).toContain("py-0.5");
      expect(pill.className).toContain("text-[11px]");
    });
  });

  describe("rendering edge cases", () => {
    it("returns null when scrollElement is null", () => {
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={100}
          scrollElement={null}
        />,
      );

      expect(container.querySelector('[data-testid="scroll-position-indicator"]')).toBeNull();
    });

    it("returns null when virtualItems is empty", () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={[]}
          totalCount={100}
          scrollElement={el}
        />,
      );

      expect(container.querySelector('[data-testid="scroll-position-indicator"]')).toBeNull();
    });

    it("returns null when totalCount is 0", () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={0}
          scrollElement={el}
        />,
      );

      expect(container.querySelector('[data-testid="scroll-position-indicator"]')).toBeNull();
    });

    it("returns null when content fits without scrolling", () => {
      const el = createMockScrollElement({ scrollHeight: 500, clientHeight: 500 });
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={3}
          scrollElement={el}
        />,
      );

      expect(container.querySelector('[data-testid="scroll-position-indicator"]')).toBeNull();
    });

    it("displays correct range text for visible items", () => {
      const el = createMockScrollElement();
      const items = [
        { index: 4, start: 200, end: 250 },
        { index: 5, start: 250, end: 300 },
        { index: 6, start: 300, end: 350 },
      ];
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={items}
          totalCount={1000}
          scrollElement={el}
          label="items"
        />,
      );

      const pill = container.querySelector('[data-testid="scroll-position-indicator"] span')!;
      expect(pill.textContent).toContain("5");
      expect(pill.textContent).toContain("7");
      expect(pill.textContent).toContain("1,000");
      expect(pill.textContent).toContain("items");
    });

    it("uses 'rows' as the default label", () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={100}
          scrollElement={el}
        />,
      );

      const pill = container.querySelector('[data-testid="scroll-position-indicator"] span')!;
      expect(pill.textContent).toContain("rows");
    });
  });

  describe("inline snapshot of rendered classes", () => {
    it("default variant wrapper and pill classes", () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={100}
          scrollElement={el}
          variant="default"
        />,
      );

      const wrapper = container.querySelector('[data-testid="scroll-position-indicator"]')!;
      const pill = wrapper.querySelector("span")!;

      expect(wrapper.className).toMatchInlineSnapshot(
        `"sticky flex justify-center pointer-events-none py-1 z-20 transition-opacity bottom-0"`,
      );
      expect(pill.className).toMatchInlineSnapshot(
        `"rounded-md text-muted-foreground bg-background/80 backdrop-blur-sm border shadow-sm px-3 py-1 text-xs"`,
      );
    });

    it("table variant wrapper and pill classes", () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={100}
          scrollElement={el}
          variant="table"
        />,
      );

      const wrapper = container.querySelector('[data-testid="scroll-position-indicator"]')!;
      const pill = wrapper.querySelector("span")!;

      expect(wrapper.className).toMatchInlineSnapshot(
        `"sticky flex justify-center pointer-events-none py-1 z-20 transition-opacity bottom-0"`,
      );
      expect(pill.className).toMatchInlineSnapshot(
        `"rounded-md text-muted-foreground bg-muted/90 backdrop-blur-sm border shadow-sm px-3 py-1 text-xs"`,
      );
    });

    it("compact variant wrapper and pill classes", () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={100}
          scrollElement={el}
          variant="compact"
        />,
      );

      const wrapper = container.querySelector('[data-testid="scroll-position-indicator"]')!;
      const pill = wrapper.querySelector("span")!;

      expect(wrapper.className).toMatchInlineSnapshot(
        `"sticky flex justify-center pointer-events-none z-20 transition-opacity bottom-0 py-0.5"`,
      );
      expect(pill.className).toMatchInlineSnapshot(
        `"rounded-md text-muted-foreground bg-background/80 backdrop-blur-sm border shadow-sm px-2 py-0.5 text-[11px]"`,
      );
    });

    it("className merge with default variant", () => {
      const el = createMockScrollElement();
      const { container } = render(
        <ScrollPositionIndicator
          virtualItems={defaultVirtualItems}
          totalCount={100}
          scrollElement={el}
          variant="default"
          className="mt-2 z-50"
        />,
      );

      const wrapper = container.querySelector('[data-testid="scroll-position-indicator"]')!;
      expect(wrapper.className).toMatchInlineSnapshot(
        `"sticky flex justify-center pointer-events-none py-1 transition-opacity bottom-0 mt-2 z-50"`,
      );
    });
  });
});
