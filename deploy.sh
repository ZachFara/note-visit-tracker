#!/usr/bin/env bash
# Deploys this plugin's source files into the Obsidian vault's plugin folder.
# Usage: ./deploy.sh [vault-path]
#   vault-path defaults to $OBSIDIAN_VAULT_PATH, then the MaghzDovom vault.
#
# Only overwrites manifest.json, main.js, and styles.css. Never touches
# data.json — that's the plugin's runtime data and lives in the vault only.

set -euo pipefail

PLUGIN_ID="note-visit-tracker"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_VAULT_PATH="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/MaghzDovom"
VAULT_PATH="${1:-${OBSIDIAN_VAULT_PATH:-$DEFAULT_VAULT_PATH}}"
TARGET_DIR="$VAULT_PATH/.obsidian/plugins/$PLUGIN_ID"

if [[ ! -d "$VAULT_PATH/.obsidian" ]]; then
	echo "error: '$VAULT_PATH' doesn't look like an Obsidian vault (no .obsidian folder)." >&2
	exit 1
fi

mkdir -p "$TARGET_DIR"
cp "$SCRIPT_DIR/manifest.json" "$TARGET_DIR/manifest.json"
cp "$SCRIPT_DIR/main.js" "$TARGET_DIR/main.js"
cp "$SCRIPT_DIR/styles.css" "$TARGET_DIR/styles.css"

echo "Deployed $PLUGIN_ID -> $TARGET_DIR"
echo "In Obsidian: Cmd+P -> \"Reload app without saving\" to pick up the change."
