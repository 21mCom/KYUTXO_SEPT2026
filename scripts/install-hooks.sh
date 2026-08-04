#!/bin/sh
set -e

HOOK_DIR="$(git rev-parse --git-dir)/hooks"
HOOK_FILE="$HOOK_DIR/pre-commit"
CRUD_CMD="node scripts/check-crud-guards.js"
LOCKFILE_CMD="node scripts/check-lockfile-urls.js"
NO_EXTERNAL_CMD="node scripts/check-no-external-resources.js"
NOTE_RENDER_CMD="node scripts/check-note-rendering.js"
TEST_PROVIDERS_CMD="node scripts/check-test-providers.js"
NO_BUFFER_CMD="node scripts/check-no-buffer-global.js"
PDF_TEXT_CMD="node scripts/check-pdf-text-sanitized.js"
POF_PAGE_CMD="npx vitest run client/src/pages/ProofOfFundsDeclaration.documentIntegrity.test.tsx client/src/pages/ProofOfFundsDeclaration.freshnessAnchorValidation.test.tsx client/src/pages/ProofOfFundsDeclaration.nodeUnreachable.test.tsx client/src/pages/proof-of-funds/pof-pdf-data.canonicalPayload.test.ts"

# Remove outdated variants of a command (same prefix, different file list) so
# the hook doesn't accumulate stale duplicate runs when a command is updated.
remove_stale_variants() {
  prefix="$1"
  current="$2"

  if [ -f "$HOOK_FILE" ] && grep -qF "$prefix" "$HOOK_FILE"; then
    tmp="$HOOK_FILE.tmp"
    while IFS= read -r line; do
      case "$line" in
        "$current") printf '%s\n' "$line" ;;
        "$prefix"*) echo "Removed stale variant of a hook command." >&2 ;;
        *) printf '%s\n' "$line" ;;
      esac
    done < "$HOOK_FILE" > "$tmp"
    mv "$tmp" "$HOOK_FILE"
    chmod +x "$HOOK_FILE"
  fi
}

append_check() {
  cmd="$1"
  label="$2"

  if [ -f "$HOOK_FILE" ] && grep -qF "$cmd" "$HOOK_FILE"; then
    echo "Pre-commit hook already contains the $label check."
    return 0
  fi

  if [ -f "$HOOK_FILE" ]; then
    echo "$cmd" >> "$HOOK_FILE"
    echo "Appended $label check to existing pre-commit hook."
  else
    printf '#!/bin/sh\n%s\n' "$cmd" > "$HOOK_FILE"
    chmod +x "$HOOK_FILE"
    echo "Pre-commit hook installed with $label check."
  fi
}

remove_stale_variants "npx vitest run client/src/pages/ProofOfFundsDeclaration." "$POF_PAGE_CMD"

append_check "$CRUD_CMD" "CRUD guards"
append_check "$LOCKFILE_CMD" "lockfile URLs"
append_check "$NO_EXTERNAL_CMD" "no external resources"
append_check "$NOTE_RENDER_CMD" "note rendering"
append_check "$TEST_PROVIDERS_CMD" "test providers"
append_check "$NO_BUFFER_CMD" "no buffer global"
append_check "$PDF_TEXT_CMD" "pdf text sanitized"
append_check "$POF_PAGE_CMD" "Proof of Funds page tests"
