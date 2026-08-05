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

# Each managed check is written to the hook as:
#   <command> # managed-check: <key>
# The stable key (not the command string) identifies the check, so when a
# command changes (renamed script, grown vitest file list) the installer
# replaces the old line instead of piling up stale duplicates.
#
# install_check <key> <label> <command> [legacy_prefix]
#   - Removes any existing line tagged with the same key whose command differs.
#   - Removes untagged legacy lines that match the command exactly or start
#     with the optional legacy_prefix (migration from older hook formats).
#   - Ensures exactly one line for this check remains.
install_check() {
  key="$1"
  label="$2"
  cmd="$3"
  legacy_prefix="$4"

  marker="# managed-check: $key"
  line="$cmd $marker"

  if [ ! -f "$HOOK_FILE" ]; then
    printf '#!/bin/sh\n%s\n' "$line" > "$HOOK_FILE"
    chmod +x "$HOOK_FILE"
    echo "Pre-commit hook installed with $label check."
    return 0
  fi

  tmp="$HOOK_FILE.tmp"
  found=0
  removed=0
  while IFS= read -r existing; do
    case "$existing" in
      "$line")
        if [ "$found" -eq 1 ]; then
          removed=1
        else
          found=1
          printf '%s\n' "$existing"
        fi
        ;;
      *"$marker")
        # Same check key, different (stale) command.
        removed=1
        ;;
      "$cmd")
        # Untagged legacy line for the current command: replace with tagged form.
        removed=1
        ;;
      *)
        if [ -n "$legacy_prefix" ]; then
          case "$existing" in
            "$legacy_prefix"*" # managed-check: "*)
              printf '%s\n' "$existing"
              continue
              ;;
            "$legacy_prefix"*)
              # Untagged legacy variant (e.g. an older vitest file list).
              removed=1
              continue
              ;;
          esac
        fi
        printf '%s\n' "$existing"
        ;;
    esac
  done < "$HOOK_FILE" > "$tmp"

  if [ "$found" -eq 0 ]; then
    printf '%s\n' "$line" >> "$tmp"
  fi

  mv "$tmp" "$HOOK_FILE"
  chmod +x "$HOOK_FILE"

  if [ "$removed" -eq 1 ]; then
    echo "Replaced stale variant(s) of the $label check."
  elif [ "$found" -eq 1 ]; then
    echo "Pre-commit hook already contains the $label check."
  else
    echo "Appended $label check to pre-commit hook."
  fi
}

install_check "crud-guards" "CRUD guards" "$CRUD_CMD" "node scripts/check-crud-guards"
install_check "lockfile-urls" "lockfile URLs" "$LOCKFILE_CMD" "node scripts/check-lockfile-urls"
install_check "no-external-resources" "no external resources" "$NO_EXTERNAL_CMD" "node scripts/check-no-external-resources"
install_check "note-rendering" "note rendering" "$NOTE_RENDER_CMD" "node scripts/check-note-rendering"
install_check "test-providers" "test providers" "$TEST_PROVIDERS_CMD" "node scripts/check-test-providers"
install_check "no-buffer-global" "no buffer global" "$NO_BUFFER_CMD" "node scripts/check-no-buffer-global"
install_check "pdf-text-sanitized" "pdf text sanitized" "$PDF_TEXT_CMD" "node scripts/check-pdf-text-sanitized"
install_check "pof-page-tests" "Proof of Funds page tests" "$POF_PAGE_CMD" "npx vitest run client/src/pages/ProofOfFundsDeclaration."
