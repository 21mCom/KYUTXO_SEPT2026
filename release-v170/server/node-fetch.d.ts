// node-fetch v3 ships no TypeScript declarations (authored in JS). The only
// consumer is server/tor-proxy.ts, which dynamically imports it and casts the
// default export through `unknown` to its own `FetchImpl` structural type —
// so the untyped module boundary is tamed at the call site and this minimal
// declaration is sufficient to satisfy noImplicitAny (TS7016).
declare module 'node-fetch';
