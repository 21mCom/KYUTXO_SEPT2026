import type { vi } from "vitest";

/**
 * Filters a fetch spy's calls down to those targeting one of the given note
 * URLs.
 *
 * Unrelated app-level background fetches (e.g. the Tor proxy settings-token
 * sync triggered via use-node-settings) can legitimately fire while a real
 * page or panel mounts. The offline-first guarantee the notes-link tests
 * protect is narrower: the notes URL itself must never be fetched. Tests that
 * mount real app components should assert
 * `expect(fetchCallsWithNoteUrl(fetchSpy, url)).toEqual([])` instead of
 * `expect(fetchSpy).not.toHaveBeenCalled()`, which is one background fetch
 * away from a false failure.
 */
export function fetchCallsWithNoteUrl(
  fetchSpy: ReturnType<typeof vi.fn>,
  ...noteUrls: string[]
) {
  return fetchSpy.mock.calls.filter(([input]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : ((input as Request | undefined)?.url ?? String(input));
    return noteUrls.some((noteUrl) => url.includes(noteUrl));
  });
}
