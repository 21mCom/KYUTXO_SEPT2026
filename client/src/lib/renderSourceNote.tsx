import type React from "react";

// Renders a free-text note with every http(s) URL turned into an inline
// clickable link. Links are only opened externally on an explicit user click
// (window.open) — URLs are never fetched at load time, preserving offline-first
// behavior. Notes without a URL render as plain text. Used for source citation
// notes, finding descriptions, remediation text, and evidence/record notes.
export function renderSourceNote(note: string): React.ReactNode {
  const urlRegex = /https?:\/\/[^\s)]+/gi;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(note)) !== null) {
    const raw = match[0];
    // Keep trailing punctuation and stray closing wrappers (quotes/brackets that
    // aren't matched by an opening paren the regex already stops at) out of the
    // link target, but render them as visible text. A trailing "]" is only a
    // wrapper when it's unbalanced — valid IPv6 host literals (e.g.
    // http://[::1]) legitimately end with "]" and must be left intact.
    let url = raw;
    let trailing = "";
    for (;;) {
      const last = url[url.length - 1];
      if (last === undefined) break;
      if (".,;\"'>".includes(last)) {
        trailing = last + trailing;
        url = url.slice(0, -1);
      } else if (last === "]") {
        const open = (url.match(/\[/g) ?? []).length;
        const close = (url.match(/\]/g) ?? []).length;
        if (close <= open) break;
        trailing = last + trailing;
        url = url.slice(0, -1);
      } else {
        break;
      }
    }
    if (match.index > lastIndex) {
      parts.push(note.slice(lastIndex, match.index));
    }
    parts.push(
      <a
        key={`link-${key++}`}
        href={url}
        onClick={(e) => {
          e.preventDefault();
          window.open(url, "_blank", "noopener,noreferrer");
        }}
        className="text-primary underline underline-offset-2 hover:opacity-80 break-all cursor-pointer"
        title={`Open ${url}`}
      >
        {url}
      </a>,
    );
    if (trailing) parts.push(trailing);
    lastIndex = match.index + raw.length;
  }
  if (parts.length === 0) return note;
  if (lastIndex < note.length) parts.push(note.slice(lastIndex));
  return <>{parts}</>;
}
