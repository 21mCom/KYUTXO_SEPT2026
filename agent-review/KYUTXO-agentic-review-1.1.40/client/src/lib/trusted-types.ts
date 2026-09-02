/**
 * Trusted Types policy for the app's intentional HTML sinks.
 *
 * The packaged desktop app enforces `require-trusted-types-for 'script'` (see
 * the CSP in `electron/main.cjs`), so every HTML-parsing sink —
 * `dangerouslySetInnerHTML`, `document.write`, `innerHTML`, … — must receive a
 * `TrustedHTML` value produced by a named policy instead of a raw string. That
 * way injected markup from anywhere else (a compromised dependency, a stray
 * string assignment) is rejected by the browser before it can execute.
 *
 * All app-owned sinks funnel through {@link trustedHtml} here. The policy only
 * accepts markup the app itself constructed and rejects obvious script vectors
 * as defense-in-depth (the report builder HTML-escapes user-controlled values,
 * and chart styles only embed configured color strings — neither should ever
 * contain a `<script>` block or a `javascript:` URL).
 *
 * When Trusted Types are unavailable (jsdom, non-Chromium browsers, dev
 * without the enforcing CSP) the input string is returned unchanged so sinks
 * keep working; enforcement only applies where the CSP demands it.
 */

/** Policy name allowlisted implicitly by creating it once, up front. */
export const KYUTXO_TRUSTED_TYPES_POLICY_NAME = "kyutxo-app";

/**
 * Exact raw-string sink inputs injected by third-party components we ship.
 * Radix UI's ScrollArea and Select viewports render a `<style>` tag via
 * `dangerouslySetInnerHTML` with these fixed stylesheets (they hide native
 * scrollbars). Under `require-trusted-types-for 'script'` the browser runs
 * every raw-string sink through the `default` policy, so these exact strings
 * — and only these — are allowlisted there. If a dependency upgrade changes
 * them, the trusted-types browser check fails loudly instead of the app
 * breaking silently in the packaged build.
 */
const THIRD_PARTY_STATIC_SINK_ALLOWLIST: ReadonlySet<string> = new Set([
  "[data-radix-scroll-area-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}[data-radix-scroll-area-viewport]::-webkit-scrollbar{display:none}",
  "[data-radix-select-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}[data-radix-select-viewport]::-webkit-scrollbar{display:none}",
]);

/** Minimal shape of `trustedTypes.createPolicy`, avoiding lib.dom version drift. */
interface TrustedTypePolicyLike {
  createHTML(input: string): TrustedHTML;
}

interface TrustedTypePolicyFactoryLike {
  createPolicy(
    name: string,
    rules: { createHTML?: (input: string) => string },
  ): TrustedTypePolicyLike;
}

let cachedPolicy: TrustedTypePolicyLike | null | undefined;

function getPolicy(): TrustedTypePolicyLike | null {
  if (cachedPolicy !== undefined) return cachedPolicy;
  const factory = (globalThis as { trustedTypes?: TrustedTypePolicyFactoryLike })
    .trustedTypes;
  if (!factory || typeof factory.createPolicy !== "function") {
    cachedPolicy = null;
    return cachedPolicy;
  }
  try {
    cachedPolicy = factory.createPolicy(KYUTXO_TRUSTED_TYPES_POLICY_NAME, {
      createHTML(input: string): string {
        // Defense-in-depth: app-constructed markup must never carry executable
        // payloads. Throwing here fails closed — the sink simply won't update.
        if (/<script[\s>]/i.test(input) || /javascript\s*:/i.test(input)) {
          throw new Error(
            "trusted-types: refusing markup containing a script vector",
          );
        }
        return input;
      },
    });
  } catch {
    // Policy creation can throw if a CSP `trusted-types` directive elsewhere
    // forbids this name. Fall back to raw strings; sinks then rely on the
    // absence of `require-trusted-types-for` to keep working.
    cachedPolicy = null;
  }
  installDefaultPolicy(factory);
  return cachedPolicy;
}

/**
 * The `default` policy runs automatically for every raw-string HTML sink when
 * Trusted Types are enforced. We cannot route third-party library sinks
 * through the named policy, so the default policy admits exactly the known
 * static strings they inject and rejects everything else — keeping
 * enforcement meaningful against injected markup.
 */
function installDefaultPolicy(factory: TrustedTypePolicyFactoryLike): void {
  try {
    factory.createPolicy("default", {
      createHTML(input: string): string {
        if (THIRD_PARTY_STATIC_SINK_ALLOWLIST.has(input)) return input;
        throw new Error(
          "trusted-types default policy: unapproved HTML sink input",
        );
      },
    });
  } catch {
    // A 'default' policy may already exist (another library created it) or
    // policy names may be CSP-restricted. Either way we leave it alone.
  }
}

/**
 * Convert app-constructed HTML into a value safe to assign to an HTML sink
 * under `require-trusted-types-for 'script'`. Returns a `TrustedHTML` when the
 * Trusted Types API is available, otherwise the original string.
 */
export function trustedHtml(html: string): TrustedHTML | string {
  const policy = getPolicy();
  return policy ? policy.createHTML(html) : html;
}

// Policies must exist BEFORE any HTML sink fires — third-party components
// (Radix ScrollArea/Select) inject their <style> tags during the very first
// React commit, so installing lazily on first trustedHtml() call would be too
// late. main.tsx imports this module for exactly this side effect.
getPolicy();
