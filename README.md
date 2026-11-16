# SF Permission Comparator

A local desktop tool for Salesforce admins to compare permissions, profiles, and permission sets across users — side by side.

No data leaves your machine. The app runs entirely on `localhost` and reads directly from your existing Salesforce CLI session or Chrome login.

---

## Features

- **Side-by-side comparison** of up to 5 users simultaneously
- **Permission Sets** — see which are assigned to each user
- **System Permissions** — all boolean `Permissions*` fields across profiles and permission sets
- **Object Permissions** — Read / Create / Edit / Delete / View All / Modify All per object
- **Field Permissions** — per-field read/edit access, filterable by object
- **Apex Class Access** — which classes each user can invoke
- **Reports & Dashboards** — folder access levels (View / Edit / Manage), drill into dashboards and their referenced reports
- **Page Layouts & Record Types** — profile-based layout and record type visibility
- **Diff highlighting** — rows with differences are highlighted; badge counts per tab
- **Multi-org support** — switch orgs without restarting

---

## Installation

### macOS (M1/M2/M3)
1. Download `SF-Permission-Comparator-mac.zip` from [Releases](../../releases/latest)
2. Unzip and double-click `Start.command`
3. First launch: right-click → **Open** → click **Open** (one-time Gatekeeper bypass)

### macOS (Intel)
1. Download `SF-Permission-Comparator-mac-intel.zip` from [Releases](../../releases/latest)
2. Same steps as above

### Windows
1. Download `SF-Permission-Comparator-win.zip` from [Releases](../../releases/latest)
2. Unzip and double-click `sf-compare-win.exe`
3. If Windows blocks it: right-click → **Properties** → check **Unblock** → OK

---

## Authentication

The app supports three login methods — no password entry required:

| Method | How it works |
|--------|-------------|
| **Chrome session** | Reads your active Salesforce login from Chrome's cookie store (macOS only) |
| **Salesforce CLI** | Uses tokens from `sf org login web` via `~/.sfdx/` auth files |
| **OAuth PKCE** | Configure a Connected App Consumer Key for a full browser OAuth flow |

> **Chrome session** is the fastest — just be logged into your Salesforce org in Chrome and the app detects it automatically.

---

## Requirements

- macOS 12+ or Windows 10+
- Google Chrome (for Chrome session auto-login)
- OR [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) with an authenticated org

---

## Running from Source

```bash
git clone https://github.com/ShahwazImtiyaz/sf-permission-comparator.git
cd sf-permission-comparator
npm install
npm run build
node server.cjs
```

The app opens at `http://localhost:3000`.

For development with hot reload:

```bash
# Terminal 1 — backend
node server.js

# Terminal 2 — frontend dev server
npm run dev
```

---

## Building Binaries

```bash
# macOS ARM (M1/M2/M3)
npm run package:mac

# macOS Intel
npm run package:mac-x64

# Windows
npm run package:win

# All platforms + create zip files
npm run package:all-zip
```

Binaries are output to `dist-bin/`.

---

## Security

This tool runs entirely on `localhost` and never sends your Salesforce credentials to any external server. Key security measures:

- All Salesforce API calls are proxied through `localhost` — the browser never holds a live token beyond the current session
- `instanceUrl` is validated against `*.salesforce.com` (HTTPS only) on every request — SSRF prevented
- Chrome cookie decryption uses the macOS Keychain — the key is never stored on disk
- OAuth flow uses PKCE (no client secret required)
- Security headers: CSP, X-Frame-Options, X-Content-Type-Options

For a full security audit report, see [SECURITY.md](SECURITY.md).

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| App does not open | Open the URL shown in the Terminal window in Chrome manually |
| "Chrome session detection failed — keychain" | Run: `security unlock-keychain ~/Library/Keychains/login.keychain-db` |
| "Full Disk Access needed" | System Settings → Privacy & Security → Full Disk Access → enable Terminal |
| Chrome not found | Make sure Google Chrome is installed (not Chromium or other browsers) |
| No orgs found | Run `sf org login web` in Terminal, then retry |
| Wrong Mac binary | ARM binary is for M1/M2/M3. Use `mac-intel.zip` for older Intel Macs |

---

## License

MIT — see [LICENSE](LICENSE)
