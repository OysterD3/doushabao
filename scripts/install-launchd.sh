#!/bin/sh
# install-launchd.sh — install the doushabao daemon as a launchd LaunchAgent.
#
# Non-destructive: only copies the plist and (re)loads it. Never touches
# other LaunchAgents, never needs sudo (LaunchAgents run as the logged-in
# user), and can be re-run safely (it unloads first if already loaded).
set -eu

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_NAME="com.doushabao.daemon.plist"
SRC_PLIST="$REPO_DIR/scripts/$PLIST_NAME"
DEST_DIR="$HOME/Library/LaunchAgents"
DEST_PLIST="$DEST_DIR/$PLIST_NAME"

echo "==> Ensuring $REPO_DIR/var exists (launchd needs the log file's parent dir up front)"
mkdir -p "$REPO_DIR/var"

echo "==> Ensuring $DEST_DIR exists"
mkdir -p "$DEST_DIR"

echo "==> Copying $SRC_PLIST -> $DEST_PLIST"
# launchd runs with a minimal PATH, so the plist must name the node binary by
# absolute path. Resolve it here instead of trusting the checked-in default —
# a wrong path plus KeepAlive is a silent crash-loop, not a visible error.
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "!! node not found on PATH. Install Node.js >= 22.18 first." >&2
  exit 1
fi
echo "==> Using node at $NODE_BIN"

# Same reason for PATH itself: cfg.dwsBin/piBin default to the bare names
# "dws"/"pi", so the daemon needs a PATH that can actually find them. Bake in
# the installing user's PATH, which is where they were just installed.
# Escape the sed delimiter, & (means "whole match" in a replacement) and \.
ESCAPED_PATH=$(printf '%s' "$PATH" | sed -e 's/[&|\\]/\\&/g')

# The checked-in plist uses /opt/doushabao as a placeholder so the repo carries
# nobody's home directory. Point it at wherever this checkout actually lives.
ESCAPED_REPO=$(printf '%s' "$REPO_DIR" | sed -e 's/[&|\\]/\\&/g')

sed -e "s|<string>/usr/local/bin/node</string>|<string>$NODE_BIN</string>|" \
    -e "s|<string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>|<string>$ESCAPED_PATH</string>|" \
    -e "s|/opt/doushabao|$ESCAPED_REPO|g" \
    "$SRC_PLIST" > "$DEST_PLIST"

echo "==> Baked PATH into the plist: $PATH"
if ! command -v dws >/dev/null 2>&1; then
  echo "!! warning: 'dws' is not on this PATH — the daemon will not receive messages." >&2
fi
if ! command -v pi >/dev/null 2>&1; then
  echo "!! warning: 'pi' is not on this PATH — every run will fail." >&2
fi

if launchctl list | grep -q "com.doushabao.daemon"; then
  echo "==> Already loaded; unloading first so the copy above takes effect"
  launchctl unload "$DEST_PLIST" || true
fi

echo "==> Loading (launchctl load -w $DEST_PLIST)"
launchctl load -w "$DEST_PLIST"

echo "==> Done. Check status with: launchctl list | grep com.doushabao.daemon"
echo "==> Logs at: $REPO_DIR/var/daemon.log"
