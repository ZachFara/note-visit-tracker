#!/usr/bin/env bash
# Builds the plugin and copies it into a vault's plugin folder for local testing.
# Usage: ./deploy.sh /path/to/vault
#   or set OBSIDIAN_VAULT_PATH and run ./deploy.sh
#
# Only overwrites manifest.json, main.js, and styles.css. Never touches
# data.json, which is the plugin's runtime data and lives in the vault only.

set -euo pipefail

PLUGIN_ID="note-visit-tracker"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAULT_PATH="${1:-${OBSIDIAN_VAULT_PATH:-}}"

if [[ -z "$VAULT_PATH" ]]; then
	echo "usage: ./deploy.sh /path/to/vault (or set OBSIDIAN_VAULT_PATH)" >&2
	exit 1
fi
if [[ ! -d "$VAULT_PATH/.obsidian" ]]; then
	echo "error: '$VAULT_PATH' doesn't look like an Obsidian vault (no .obsidian folder)." >&2
	exit 1
fi

(cd "$SCRIPT_DIR" && npm run build)

TARGET_DIR="$VAULT_PATH/.obsidian/plugins/$PLUGIN_ID"
mkdir -p "$TARGET_DIR"
cp "$SCRIPT_DIR/manifest.json" "$TARGET_DIR/manifest.json"
cp "$SCRIPT_DIR/main.js" "$TARGET_DIR/main.js"
cp "$SCRIPT_DIR/styles.css" "$TARGET_DIR/styles.css"

echo "Deployed $PLUGIN_ID -> $TARGET_DIR"
echo "In Obsidian: Cmd+P -> \"Reload app without saving\" to pick up the change."
