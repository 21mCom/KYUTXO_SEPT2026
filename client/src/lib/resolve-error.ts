/**
 * Turn a caught "Resolve & Recompute" (or any node-backed resolution) error into
 * a short, user-meaningful reason. Resolving a spend can fail two ways the user
 * can act on:
 *  - Connectivity: the resolver had to reach a Bitcoin node (or Tor proxy) for a
 *    missing source transaction and couldn't — a timeout, a refused/unreachable
 *    connection, an offline node, etc. Retrying once the node is reachable helps.
 *  - Internal: an unexpected engine/database error. Retrying usually won't help
 *    on its own, so we tell the user it was an internal error.
 * This stays offline-first: it only inspects the error text already produced
 * locally and never makes a network call.
 */
export function describeResolveError(err: unknown): string {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const lower = message.toLowerCase();
  const looksLikeConnectivity =
    /\b(node|network|connection|connect|unreachable|offline|timed?\s*out|timeout|fetch|proxy|tor|socket|econn|enotfound|etimedout|dns)\b/.test(
      lower,
    );
  if (looksLikeConnectivity) {
    return "Couldn't reach your Bitcoin node to look up a source transaction. Check that your node is online and reachable, then try again.";
  }
  return "An internal error stopped the resolve. Retrying may not help — see the console for details.";
}
