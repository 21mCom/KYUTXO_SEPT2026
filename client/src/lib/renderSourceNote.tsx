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
    // Keep trailing punctuation out of the link target, but render it as text.
    const trailing = raw.match(/[.,;]+$/)?.[0] ?? "";
    const url = trailing ? raw.slice(0, raw.length - trailing.length) : raw;
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
