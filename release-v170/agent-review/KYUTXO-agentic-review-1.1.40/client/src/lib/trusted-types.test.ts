import { afterEach, describe, expect, it, vi } from "vitest";

import { KYUTXO_TRUSTED_TYPES_POLICY_NAME, trustedHtml } from "@/lib/trusted-types";

interface FakePolicy {
  createHTML(input: string): { readonly __trusted: string };
}

interface FakeFactory {
  createPolicy(
    name: string,
    rules: { createHTML?: (input: string) => string },
  ): FakePolicy;
}

function installFakeTrustedTypes(factory: FakeFactory | undefined) {
  const g = globalThis as { trustedTypes?: unknown };
  if (factory === undefined) {
    delete g.trustedTypes;
  } else {
    g.trustedTypes = factory;
  }
}

function makeFakeFactory() {
  const calls: string[] = [];
  const policies = new Map<string, { createHTML?: (input: string) => string }>();
  const factory: FakeFactory = {
    createPolicy(name, rules) {
      calls.push(name);
      policies.set(name, rules);
      return {
        createHTML(input: string) {
          return { __trusted: rules.createHTML ? rules.createHTML(input) : input };
        },
      };
    },
  };
  return { factory, calls, policies };
}

afterEach(() => {
  installFakeTrustedTypes(undefined);
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("trustedHtml", () => {
  it("returns the raw string when Trusted Types are unavailable", async () => {
    installFakeTrustedTypes(undefined);
    const { trustedHtml: freshTrustedHtml } = await import("@/lib/trusted-types");
    expect(freshTrustedHtml("<b>ok</b>")).toBe("<b>ok</b>");
  });

  it("creates the named policy once and routes markup through it", async () => {
    installFakeTrustedTypes(undefined);
    const { factory, calls } = makeFakeFactory();
    installFakeTrustedTypes(factory);
    const { trustedHtml: freshTrustedHtml } = await import("@/lib/trusted-types");

    const first = freshTrustedHtml("<i>one</i>") as unknown as { __trusted: string };
    const second = freshTrustedHtml("<i>two</i>") as unknown as { __trusted: string };

    expect(calls).toEqual([KYUTXO_TRUSTED_TYPES_POLICY_NAME, "default"]);
    expect(first.__trusted).toBe("<i>one</i>");
    expect(second.__trusted).toBe("<i>two</i>");
  });

  it("default policy allowlists the known Radix style sinks and rejects all else", async () => {
    installFakeTrustedTypes(undefined);
    const { factory, policies } = makeFakeFactory();
    installFakeTrustedTypes(factory);
    const { trustedHtml: freshTrustedHtml } = await import("@/lib/trusted-types");
    freshTrustedHtml("<i>trigger policy install</i>");

    const defaultPolicy = policies.get("default");
    expect(defaultPolicy).toBeDefined();
    const radixScrollArea =
      "[data-radix-scroll-area-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}[data-radix-scroll-area-viewport]::-webkit-scrollbar{display:none}";
    const radixSelect =
      "[data-radix-select-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}[data-radix-select-viewport]::-webkit-scrollbar{display:none}";
    expect(defaultPolicy!.createHTML!(radixScrollArea)).toBe(radixScrollArea);
    expect(defaultPolicy!.createHTML!(radixSelect)).toBe(radixSelect);
    expect(() => defaultPolicy!.createHTML!('<img src=x onerror=alert(1)>')).toThrow(/unapproved/);
    expect(() => defaultPolicy!.createHTML!("<b>anything else</b>")).toThrow(/unapproved/);
  });

  it("rejects markup containing script vectors", async () => {
    installFakeTrustedTypes(undefined);
    const { factory } = makeFakeFactory();
    installFakeTrustedTypes(factory);
    const { trustedHtml: freshTrustedHtml } = await import("@/lib/trusted-types");

    expect(() => freshTrustedHtml('<script>alert(1)</script>')).toThrow(/script vector/);
    expect(() => freshTrustedHtml('<SCRIPT src=x>')).toThrow(/script vector/);
    expect(() => freshTrustedHtml('<a href="javascript:alert(1)">x</a>')).toThrow(/script vector/);
  });

  it("falls back to raw strings when policy creation is refused", async () => {
    installFakeTrustedTypes(undefined);
    installFakeTrustedTypes({
      createPolicy() {
        throw new Error("disallowed by CSP");
      },
    });
    const { trustedHtml: freshTrustedHtml } = await import("@/lib/trusted-types");
    expect(freshTrustedHtml("<b>ok</b>")).toBe("<b>ok</b>");
  });
});
