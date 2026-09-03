import { describe, expect, it } from "vitest";
import { isLocalOrPrivateHostname, isLocalOrPrivateUrl } from "./types";

describe("local/private destination classification", () => {
  it.each([
    "localhost",
    "node.localhost",
    "umbrel.local",
    "127.99.1.2",
    "10.4.3.2",
    "172.31.255.1",
    "192.168.2.3",
    "169.254.8.9",
    "100.64.0.1",
    "100.127.255.254",
    "0.0.0.0",
    "[::]",
    "[::1]",
    "[fc00::1]",
    "[fd12:3456::1]",
    "[fe80::1]",
    "[febf::1]",
    "[::ffff:7f00:1]",
    "[::ffff:a00:1]",
    "[::ffff:6440:1]",
  ])("classifies %s as local/private", (hostname) => {
    expect(isLocalOrPrivateHostname(hostname)).toBe(true);
  });

  it.each([
    "100.63.255.255",
    "100.128.0.0",
    "8.8.8.8",
    "[2001:4860:4860::8888]",
    "[fec0::1]",
  ])("does not classify %s as local/private", (hostname) => {
    expect(isLocalOrPrivateHostname(hostname)).toBe(false);
  });

  it("handles URL parsing and keeps onion hosts Tor-routable", () => {
    expect(isLocalOrPrivateUrl("http://[::ffff:127.0.0.1]:3002/api")).toBe(true);
    expect(isLocalOrPrivateUrl("http://[fd12::1]:3002/api")).toBe(true);
    expect(isLocalOrPrivateUrl("http://nodeabcdef.onion/api")).toBe(false);
    expect(isLocalOrPrivateUrl("not a URL")).toBe(false);
  });
});