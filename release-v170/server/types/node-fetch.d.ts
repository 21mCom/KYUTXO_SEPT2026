// Minimal local declaration for the CJS `node-fetch` v2 dependency.
// The published @types/node-fetch package is not installable in this
// environment, and server/tor-proxy.ts immediately casts the default export
// to its own FetchImpl signature, so a loose module declaration is enough to
// satisfy `tsc` without weakening call-site typing.
declare module "node-fetch" {
  const fetch: (...args: unknown[]) => Promise<unknown>;
  export default fetch;
}
