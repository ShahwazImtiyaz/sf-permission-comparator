#!/usr/bin/env node
// Slim zip (~400 KB): express bundled via esbuild, no npm install needed at runtime.
// Node.js auto-downloaded silently on first launch if not installed.
// Start.command opens Chrome automatically.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distBin = path.join(root, 'dist-bin');

const README = `SF Permission Comparator

HOW TO RUN — macOS
──────────────────
FIRST TIME only (one-time Gatekeeper bypass):
  1. Open Terminal  (Cmd+Space → type Terminal → Enter)
  2. Drag the SF-Permission-Comparator folder into Terminal, press Enter
  3. Run:  chmod +x Start.command && xattr -dr com.apple.quarantine .
  4. Double-click Start.command — Chrome opens automatically

After the first time: just double-click Start.command.
Close the Terminal window to stop the app.

TROUBLESHOOTING
───────────────
App does not open  →  Open http://localhost:3000 in Chrome manually.
Port in use        →  Close the existing Terminal window and try again.
`;

// express is pre-bundled — zero npm install on launch.
// Node.js auto-downloaded to .node/ if not present.
const MAC_START = `#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# ── Locate Node.js ────────────────────────────────────────────────────────────

# 1. Previously auto-downloaded
if [ -x "$DIR/.node/bin/node" ]; then
  export PATH="$DIR/.node/bin:$PATH"
fi

# 2. System node
if ! command -v node &>/dev/null; then
  export PATH="/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:$PATH"
  [ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
fi

# 3. Auto-download node if still not found (one-time, ~35 MB)
if ! command -v node &>/dev/null; then
  ARCH="$(uname -m)"
  [ "$ARCH" = "arm64" ] && PKG="node-v18.20.4-darwin-arm64" || PKG="node-v18.20.4-darwin-x64"
  echo "Downloading Node.js runtime (one-time)..."
  if curl -L --progress-bar "https://nodejs.org/dist/v18.20.4/\${PKG}.tar.gz" -o /tmp/node-dl.tar.gz && \\
     tar -xzf /tmp/node-dl.tar.gz -C "$DIR" && mv "$DIR/$PKG" "$DIR/.node" && rm -f /tmp/node-dl.tar.gz; then
    export PATH="$DIR/.node/bin:$PATH"
  else
    osascript -e 'display alert "Setup failed" message "Could not download Node.js. Install from https://nodejs.org/ then try again." as warning' 2>/dev/null
    exit 1
  fi
fi

# ── Start server and open Chrome ──────────────────────────────────────────────

PORT_FILE="/tmp/.sfpc.port"

# Kill any previous instance using saved port
if [ -f "$PORT_FILE" ]; then
  OLD_PORT="$(cat "$PORT_FILE")"
  lsof -ti:"$OLD_PORT" | xargs kill -9 2>/dev/null
  sleep 0.3
fi
rm -f "$PORT_FILE"

echo "Starting..."
node "$DIR/server-bundle.cjs" > "$HOME/.sfpc.log" 2>&1 &
SERVER_PID=$!

# Wait up to 15 s for the server to write its chosen port
PORT=""
for i in $(seq 1 30); do
  sleep 0.5
  if [ -f "$PORT_FILE" ]; then
    PORT="$(cat "$PORT_FILE")"
    break
  fi
done

if [ -z "$PORT" ]; then
  echo "Server failed to start. Check log: $HOME/.sfpc.log" >&2
  cat "$HOME/.sfpc.log" >&2
  exit 1
fi

URL="http://localhost:${PORT}"
open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"

echo "SF Permission Comparator running at $URL"
echo "Close this window to stop."
wait $SERVER_PID
`;

const WIN_START = `@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found. Install from https://nodejs.org/ then restart your PC.
  pause & exit /b 1
)
echo Starting...
node server-bundle.cjs
pause
`;

function buildSlimZip() {
  if (!fs.existsSync(distBin)) fs.mkdirSync(distBin, { recursive: true });

  // Bundle server + express into one file (no npm install needed)
  console.log('Bundling server + express...');
  const bundleOut = path.join(distBin, '_server-bundle.cjs');
  execSync(
    `npx esbuild "${path.join(root, 'server.cjs')}" --bundle --platform=node --outfile="${bundleOut}"`,
    { stdio: 'inherit', cwd: root }
  );
  console.log(`Bundle: ${Math.round(fs.statSync(bundleOut).size / 1024)} KB`);

  const staging = path.join(distBin, '_staging_slim');
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true });
  fs.mkdirSync(staging);

  fs.cpSync(path.join(root, 'dist'), path.join(staging, 'dist'), { recursive: true });
  fs.copyFileSync(bundleOut, path.join(staging, 'server-bundle.cjs'));

  const macStart = path.join(staging, 'Start.command');
  fs.writeFileSync(macStart, MAC_START);
  fs.chmodSync(macStart, 0o755);
  fs.writeFileSync(path.join(staging, 'start.bat'), WIN_START);
  fs.writeFileSync(path.join(staging, 'README.txt'), README);

  const zipName = 'SF-Permission-Comparator-slim.zip';
  const zipPath = path.join(distBin, zipName);
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);

  const folderName = 'SF-Permission-Comparator';
  execSync(
    `cd "${distBin}" && mv "_staging_slim" "${folderName}" && zip -r -9 "${zipName}" "${folderName}" && mv "${folderName}" "_staging_slim"`,
    { stdio: 'inherit' }
  );

  fs.rmSync(staging, { recursive: true });
  fs.rmSync(bundleOut, { force: true });

  const bytes = fs.statSync(zipPath).size;
  const label = bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
  console.log(`\nCreated dist-bin/${zipName}  (${label})`);
  console.log('No npm install — express pre-bundled. Node.js auto-downloads if missing.');
}

buildSlimZip();
