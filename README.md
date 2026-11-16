# PrintHub

Self-service printing for local print shops: customers scan a QR code, upload documents from
their phone, preview A4 output, pay by UPI, and the shop's Windows PC prints once the
shopkeeper confirms payment. No cloud backend. See `prd` for the full requirements.

```
packages/
  shared/    Pure logic used by both browser and server: options, page ranges, A4/N-up layout, pricing
  server/    Local backend (Node, no native modules): API, SQLite, PDF engine, print queue, drivers
  web/       React app: customer page (index.html) + shopkeeper dashboard (admin.html)
  launcher/  Two static files for GitHub Pages that forward a QR scan to the shop PC
  desktop/   Electron shell: runs the server in-process, tray icon, Windows installer
```

## Key design decisions

**GitHub Pages is a launcher, not the app.** A page served over `https://…github.io` cannot
call `http://192.168.x.x` (mixed content, and Chrome's Private Network Access). So the QR
encodes `https://r4p5.github.io/<mobile>#h=<lan-ip>:3000`; the launcher validates the number
and the private address and forwards the browser to the shop PC, which serves the customer
app itself (same origin: no CORS, no mixed content). The `#fragment` never reaches GitHub.
If the PC's LAN address changes, the desktop app notifies the shopkeeper to reprint the QR;
a DHCP reservation in the router avoids this.

**Preview = print.** `layoutSheets()` in `shared` computes every sheet side; the phone draws
it on canvas and the server draws the same geometry into the print PDF with pdf-lib. Pricing
works the same way: instant in the browser, authoritative on the server at checkout.

**Never print twice.** A task is marked `printing` *before* it is handed to the spooler. After
a crash, or if the job leaves the spooler after an error, the outcome is unknown and the task
goes to `manual_review`; only the shopkeeper decides ("It printed" / "Print again" / "Skip").
Automatic retry is limited to failures that certainly printed nothing.

**Pull-based per-printer queues.** Each idle printer takes the oldest compatible task. A backup
printer takes work only while every better-priority compatible printer is offline, in error,
or disabled. Jobs never fall back to an incompatible printer.

### Resource use (the PC runs this all day)

- Idle: no timers firing, about 74 MB RSS for the bare server. SSE heartbeats and spooler polling
  run only while someone is connected or something is printing; polling backs off from 1.5 s to 5 s.
- PDF work runs in one worker thread, started on demand and stopped after 30 s idle. One task
  at a time caps memory; quick upload inspections jump ahead of renders.
- Windows spooler queries reuse one PowerShell process (started on demand, exits after 60 s idle)
  instead of starting PowerShell (about 1 s of CPU) for every poll.
- Uploads stream to disk with hard limits (50 MB/file, 20 files/order). The file type is checked
  from content, not the extension. Free disk space is checked first.
- SQLite in WAL mode with cached prepared statements; settings and printers are held in memory.
- Static assets are pre-compressed with brotli and gzip at build time and cached as immutable.
  The customer page is about 85 KB gzipped on first load; pdf.js is fetched only when a PDF is added.
- Phone preview: header-only image sizing (no full decode of large photos), thumbnails rendered
  one at a time into a 40-entry LRU that frees bitmaps, sheets drawn only when scrolled into view.
- Electron: GPU disabled, window destroyed on close (the server keeps running in the tray),
  `pdf-lib` split out of the main bundle (81 KB). Sleep is blocked only while the shop is open.

### Security

- Requests from non-private IPs are rejected. Admin APIs require loopback **and** a token, which
  also blocks DNS-rebinding and cross-site requests. The Electron preload passes the token to
  the dashboard.
- Customer job access uses an HMAC token per job; a wrong token gets the same 404 as a missing
  job. Printer names and internal settings are never sent to customers.
- Payment is confirmed only by the shopkeeper. A mismatched amount goes to review; prices are
  locked at checkout.

## Development

Requires Node 22.13+ (uses built-in `node:sqlite` and TypeScript type-stripping; no build step for the server).

```bash
npm install
npm run build:web          # builds packages/web/dist
npm run dev:server         # http://localhost:3000 (mock printers); prints the admin token
# dashboard: http://localhost:3000/admin?token=<token>
npm run dev:web            # optional: Vite dev server with /api proxied to :3000
npm test                   # shared + server integration tests (mock printer driver)
npm run typecheck
```

Without Windows, the server uses `MockDriver`, which "prints" by copying the final PDF into
`<data>/mock-output/`, so you can open exactly what would be printed.

## Getting the Windows installer (.exe)

### Option A: download it from GitHub (no Windows PC needed)

Every push to `main` builds the installer on GitHub's Windows machines
(`.github/workflows/build-windows.yml`).

1. Open the repository on GitHub → **Actions** → **Build Windows installer**.
2. Open the latest green run → **Artifacts** → download **PrintHub-Setup** (a zip containing
   `PrintHub Setup x.y.z.exe`).
3. To publish a version as a GitHub Release with the `.exe` attached, push a tag:
   `git tag v0.1.0 && git push origin v0.1.0`.

You can also start a build manually: Actions → Build Windows installer → **Run workflow**.

The installer is not code-signed, so Windows SmartScreen shows "Windows protected your PC".
Click **More info → Run anyway**. Removing the warning requires a code-signing certificate.

### Option B: build it on a Windows PC

Requires Node.js 22.13+ and Git. On a Windows machine:

```bash
npm install
npm run sumatra -w @printhub/desktop   # fetches portable SumatraPDF into packages/desktop/resources
npm run dist:win                        # -> packages/desktop/release/PrintHub Setup x.y.z.exe
```

The installer (per-machine, one UAC prompt) adds a firewall rule for TCP 3000 limited to the
local subnet, creates `C:\ProgramData\PrintHub` writable by standard users, and registers
auto-start at login (`--hidden`, tray only).

## Customer launcher on GitHub Pages

The shop QR codes point to `https://r4p5.github.io/<mobile>#h=<shop-pc-ip>:3000`. These are
served by the public repository **`r4p5/r4p5.github.io`**, which holds only
`packages/launcher/index.html` and `404.html` (`404.html` makes every `/<mobile>` path work
without per-shop files). After changing the launcher, copy both files to that repository and push.

Check it: open `https://r4p5.github.io/9066191970`. Without `#h=…` it says to scan the shop
QR. With `#h=192.168.1.10:3000` it forwards to the shop PC.

## First-time shop setup (after installing)

1. Run the installer on the shop PC. PrintHub opens the setup wizard.
2. Enter the shop name and mobile number, enable the printers, set prices and the UPI ID.
3. Print the QR poster from **Shop & QR** and put it at the counter.
4. In the router settings, add a **DHCP reservation** for this PC so its IP address never
   changes; otherwise the QR stops working when the router hands out a new address.
5. Recommended for unattended shops: enable Windows auto-login, and the BIOS setting
   "Restore on AC power loss = On", so PrintHub comes back by itself after a power cut.

## Status / not yet verified

Built and tested on Linux with the mock driver. **Not yet run on Windows**:

- `WindowsDriver`: printer discovery via `Win32_Printer`, SumatraPDF `-print-to` settings,
  and spooler job tracking via `Win32_PrintJob` (Phase 1 of the PRD). Validate with real USB
  and Wi-Fi printers, especially duplex/color capability detection, which varies by driver.
- Electron shell and NSIS installer (`node:sqlite` needs Electron 35+; if a target Electron
  build lacks it, `db.ts` is the only module to swap for `better-sqlite3`, which has a near-identical API).
- Real phones: pdf.js legacy build on older Android browsers, UPI intent hand-off.

Not implemented (PRD items deferred): server-side preview endpoint (`/api/jobs/:id/preview`;
the preview runs on the phone from the shared layout instead), paper-size routing (everything prints A4).
