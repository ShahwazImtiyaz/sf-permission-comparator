#!/usr/bin/env node
// Creates distributable zips from the pkg binaries:
//   dist-bin/SF-Permission-Comparator-mac.zip  (macOS ARM64)
//   dist-bin/SF-Permission-Comparator-mac-x64.zip  (macOS Intel)
//   dist-bin/SF-Permission-Comparator-win.zip  (Windows x64)

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distBin = path.join(root, 'dist-bin');

const MAC_README = `SF Permission Comparator

HOW TO RUN — macOS
──────────────────
Double-click Start.command — Chrome opens automatically.
Close the Terminal window to stop the app.

If macOS shows "cannot be opened because the developer cannot be verified":
  → Right-click Start.command → Open → click Open in the dialog.

TROUBLESHOOTING
───────────────
App does not open  →  Open the URL shown in the Terminal window in Chrome manually.
Wrong Mac type     →  ARM binary is for M1/M2/M3 Macs. Use mac-intel.zip for older Intel Macs.
Port in use        →  Close the existing Terminal window and try again.
`;

const WIN_README = `SF Permission Comparator — Windows

HOW TO RUN
──────────
1. Double-click  sf-compare-win.exe
   (If Windows blocks it: right-click → Properties → check "Unblock" → OK)

WHAT IT DOES
────────────
Starts a small local server and opens the app in your browser.
It reads your existing Salesforce session from Chrome — no password needed.
Make sure you are logged into Salesforce in Chrome before starting.

To stop: close the command prompt window that opens.
`;

const MAC_COMMAND = `#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
# Auto-remove macOS quarantine — no manual Terminal steps needed on first run
xattr -dr com.apple.quarantine "$DIR" 2>/dev/null || true
chmod +x sf-compare-mac 2>/dev/null

PORT_FILE="/tmp/.sfpc.port"

# Kill any previous instance using the saved port
if [ -f "$PORT_FILE" ]; then
  OLD_PORT="$(cat "$PORT_FILE")"
  lsof -ti:"\${OLD_PORT}" | xargs kill -9 2>/dev/null
  sleep 0.3
fi
rm -f "$PORT_FILE"

# Start server in background (output goes to log)
"$DIR/sf-compare-mac" > "$HOME/.sfpc.log" 2>&1 &
SERVER_PID=\$!

# Wait up to 15 s for the server to write its chosen port
PORT=""
for i in \$(seq 1 30); do
  sleep 0.5
  if [ -f "$PORT_FILE" ]; then
    PORT="\$(cat "$PORT_FILE")"
    break
  fi
  # Binary exited early — no point waiting further
  if ! kill -0 "\$SERVER_PID" 2>/dev/null; then break; fi
done

if [ -z "\$PORT" ]; then
  echo "" >&2
  echo "SF Permission Comparator failed to start." >&2
  # Detect Intel Mac running the ARM binary
  if [ "$(uname -m)" = "x86_64" ]; then
    echo "" >&2
    echo "You appear to be on an Intel Mac. Please download:" >&2
    echo "  SF-Permission-Comparator-mac-intel.zip" >&2
  else
    echo "Check log: \$HOME/.sfpc.log" >&2
    cat "\$HOME/.sfpc.log" >&2
  fi
  exit 1
fi

URL="http://localhost:\${PORT}"
echo "SF Permission Comparator running at \$URL"
echo "Close this window to stop the server."
# Browser is opened by the binary itself — no need to open it here too.
wait \$SERVER_PID
`;

const MAC_X64_COMMAND = `#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
# Auto-remove macOS quarantine — no manual Terminal steps needed on first run
xattr -dr com.apple.quarantine "$DIR" 2>/dev/null || true
chmod +x sf-compare-mac-x64 2>/dev/null

PORT_FILE="/tmp/.sfpc.port"

if [ -f "$PORT_FILE" ]; then
  OLD_PORT="$(cat "$PORT_FILE")"
  lsof -ti:"\${OLD_PORT}" | xargs kill -9 2>/dev/null
  sleep 0.3
fi
rm -f "$PORT_FILE"

"$DIR/sf-compare-mac-x64" > "$HOME/.sfpc.log" 2>&1 &
SERVER_PID=\$!

PORT=""
for i in \$(seq 1 30); do
  sleep 0.5
  if [ -f "$PORT_FILE" ]; then
    PORT="\$(cat "$PORT_FILE")"
    break
  fi
  # Binary exited early — no point waiting further
  if ! kill -0 "\$SERVER_PID" 2>/dev/null; then break; fi
done

if [ -z "\$PORT" ]; then
  echo "" >&2
  echo "SF Permission Comparator failed to start." >&2
  echo "Check log: \$HOME/.sfpc.log" >&2
  cat "\$HOME/.sfpc.log" >&2
  exit 1
fi

URL="http://localhost:\${PORT}"
echo "SF Permission Comparator running at \$URL"
echo "Close this window to stop the server."
# Browser is opened by the binary itself — no need to open it here too.
wait \$SERVER_PID
`;

function makeZip({ binaryName, zipName, readmeContent, commandContent, commandName }) {
  const binaryPath = path.join(distBin, binaryName);
  if (!fs.existsSync(binaryPath)) {
    console.log(`  skip ${zipName} — binary not found: ${binaryName}`);
    return;
  }

  const staging = path.join(distBin, '_staging_' + zipName);
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true });
  fs.mkdirSync(staging);

  // copy binary
  fs.copyFileSync(binaryPath, path.join(staging, binaryName));
  if (!binaryName.endsWith('.exe')) {
    fs.chmodSync(path.join(staging, binaryName), 0o755);
  }

  // write README
  fs.writeFileSync(path.join(staging, 'README.txt'), readmeContent);

  // write launcher script for macOS
  if (commandContent && commandName) {
    const cmdPath = path.join(staging, commandName);
    fs.writeFileSync(cmdPath, commandContent);
    fs.chmodSync(cmdPath, 0o755);
  }

  const zipPath = path.join(distBin, zipName);
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);

  // zip with flat folder name
  const folderName = zipName.replace('.zip', '');
  execSync(
    `cd "${distBin}" && rm -rf "${folderName}" && mv "_staging_${zipName}" "${folderName}" && zip -r -9 "${zipName}" "${folderName}" && mv "${folderName}" "_staging_${zipName}"`,
    { stdio: 'inherit' }
  );

  fs.rmSync(staging, { recursive: true });
  const size = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
  console.log(`  created ${zipName} (${size} MB)`);
}

console.log('Building zips from dist-bin binaries…\n');

makeZip({
  binaryName: 'sf-compare-mac',
  zipName: 'SF-Permission-Comparator-mac.zip',
  readmeContent: MAC_README,
  commandContent: MAC_COMMAND,
  commandName: 'Start.command',
});

makeZip({
  binaryName: 'sf-compare-mac-x64',
  zipName: 'SF-Permission-Comparator-mac-intel.zip',
  readmeContent: MAC_README.replace('macOS ARM64', 'macOS Intel'),
  commandContent: MAC_X64_COMMAND,
  commandName: 'Start.command',
});

makeZip({
  binaryName: 'sf-compare-win.exe',
  zipName: 'SF-Permission-Comparator-win.zip',
  readmeContent: WIN_README,
});

console.log('\nDone. Share the zip files from dist-bin/');
