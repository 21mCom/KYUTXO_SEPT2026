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
POF_PAGE_CMD="npx vitest run client/src/pages/ProofOfFundsDeclaration.documentIntegrity.test.tsx client/src/pages/ProofOfFundsDeclaration.freshnessAnchorValidation.test.tsx client/src/pages/ProofOfFundsDeclaration.nodeUnreachable.test.tsx"

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

append_check "$CRUD_CMD" "CRUD guards"
append_check "$LOCKFILE_CMD" "lockfile URLs"
append_check "$NO_EXTERNAL_CMD" "no external resources"
append_check "$NOTE_RENDER_CMD" "note rendering"
append_check "$TEST_PROVIDERS_CMD" "test providers"
append_check "$NO_BUFFER_CMD" "no buffer global"
append_check "$PDF_TEXT_CMD" "pdf text sanitized"
append_check "$POF_PAGE_CMD" "Proof of Funds page tests"
