# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please open a [GitHub Issue](../../issues) or contact the maintainer directly. Do not include exploit details in public issues.

## Design Principles

SF Permission Comparator is a **local-only** tool. It runs entirely on `localhost` and never transmits your Salesforce credentials or org data to any external server.

## Security Controls

| Control | Implementation |
|---------|---------------|
| SSRF prevention | `instanceUrl` validated against `*.salesforce.com` (HTTPS only) on every proxy request |
| Path traversal | `path.basename()` + `path.resolve()` guard before reading `~/.sfdx/` auth files |
| Token exposure | `accessToken` never included in org-listing API responses; fetched only on-demand |
| HTTPS enforcement | `sfGet` rejects non-HTTPS connections at the application layer |
| CSRF protection | Cross-origin POST requests rejected via `Origin` header check |
| OAuth security | PKCE flow (S256) — no client secret required or stored |
| Pinned sessions | 30-minute TTL + per-IP rate limiting (10 req/min) |
| File permissions | OAuth config written with `mode 0o600` (owner-read only) |
| Command injection | SQLite queries use `execFileSync` array form — no shell string interpolation |
| Security headers | CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy on all responses |
| Error messages | File paths and system internals stripped from error responses |
| Input validation | Salesforce IDs validated against 15/18-char alphanumeric format before SOQL use |

## Data Handling

- **Chrome cookie decryption** — uses macOS Keychain (`Chrome Safe Storage`). The AES key is derived in-memory and never written to disk.
- **Salesforce tokens** — stored in `sessionStorage` (cleared when tab closes). Never written to `localStorage` or disk.
- **Org credentials** — read from `~/.sfdx/` (Salesforce CLI) or Chrome cookies at runtime. Never copied or cached by the app.
- **No telemetry** — the app makes no outbound connections other than to your Salesforce org's API endpoints.

## Supported Versions

Security fixes are applied to the latest release only.
