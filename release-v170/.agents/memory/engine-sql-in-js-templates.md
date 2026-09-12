---
name: Engine SQL string literals inside JS template literals
description: Backslash/quote escaping gotcha when embedding SQLite SQL (with replace()-built JSON) inside JS template-literal query strings.
---

# Embedding SQLite SQL with backslashes inside JS template literals

The native engine builds query SQL as JS template-literal strings. JS processes
backslash escapes in the template literal BEFORE the string ever reaches SQLite.
So to make SQLite receive a SQL literal that contains a backslash you must DOUBLE
it in the JS source:

- JS source `'\\'`   -> SQLite sees `'\'`   (one backslash)
- JS source `'\\\\'` -> SQLite sees `'\\'`  (two backslashes)
- JS source `'\\"'`  -> SQLite sees `'\"'`  (backslash + quote)

**Why:** getWalletUsageSummaries() classifies receive/change by deriving the chain
from derivationPath. It rebuilds a JSON array in SQL (replace '/' with '","') so it
can reuse json_array_length/json_extract, mirroring JS `path.split('/')`. If a path
contains `"` or `\`, naive concat produces invalid JSON, json_valid fails, and the
row wrongly falls back to 'receive'. The escape chain MUST run backslash THEN quote
(escaping quotes first leaves the inserted `\` unescaped).

**How to apply:** When editing any engine SQL that builds JSON/strings via manual
concatenation, verify the EMITTED SQL (not the JS source) with a standalone
better-sqlite3 script. Prefer `json_quote()` / `JSON.stringify` over hand-rolled
escaping. Manual escaping still misses raw control chars (newline/tab/NUL); those
rows fall back via json_valid, which is acceptable for BIP-style paths only.
