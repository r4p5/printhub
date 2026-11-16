import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, powerMonitor, powerSaveBlocker, shell, Tray } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lanAddresses, startServer, type App } from '@printhub/server';

const PORT = 3000;
const startHidden = process.argv.includes('--hidden');

// The dashboard is a few forms; skipping the GPU process saves ~50-100 MB on shop PCs.
app.disableHardwareAcceleration();

if (!app.requestSingleInstanceLock()) app.quit();

let server: App | null = null;
let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let blocker: number | null = null;
let lastAddress: string | null = null;
let quitting = false;

// Packaged: electron-builder extraResources. Development: paths relative to dist/main.js.
const DEV_RESOURCES: Record<string, string> = { web: '../../web/dist', 'SumatraPDF.exe': '../resources/SumatraPDF.exe', 'tray.png': '../build/tray.png' };
const resource = (name: string) => (app.isPackaged ? join(process.resourcesPath, name) : fileURLToPath(new URL(DEV_RESOURCES[name]!, import.meta.url)));

async function boot() {
  try {
    server = await startServer({ port: PORT, webDir: resource('web'), sumatraPath: resource('SumatraPDF.exe') });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    dialog.showErrorBox(
      'PrintHub could not start',
      err.code === 'EADDRINUSE' ? `Port ${PORT} is used by another program. Close it (or another PrintHub window) and start PrintHub again.` : err.message,
    );
    app.exit(1);
    return;
  }
  server.hub.listen(onServerEvent);
  lastAddress = lanAddresses()[0]?.address ?? null;
  updateKeepAwake();
  buildTray();
  if (!startHidden) openWindow();
}

/** Native notifications so the shopkeeper notices orders even with the window closed. */
function onServerEvent(channel: string, event: string, data: unknown) {
  if (channel !== 'admin') return;
  const d = data as { state?: string; error?: string };
  if (event === 'job' && d.state === 'payment_pending') notify('Payment to verify', 'A customer says they have paid. Check your UPI app and confirm.');
  else if (event === 'alert' && d.state !== 'completed') notify('Printing needs attention', d.error ?? 'Check the PrintHub dashboard.');
  else if (event === 'settings') {
    updateKeepAwake();
    buildTray();
  }
}

function notify(title: string, body: string) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', openWindow);
  n.show();
}

/** While open for orders the PC must not sleep, or customers can't reach it. Display may still turn off. */
function updateKeepAwake() {
  const open = server?.settings.get('general').open ?? false;
  if (open && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!open && blocker !== null) {
    powerSaveBlocker.stop(blocker);
    blocker = null;
  }
}

function buildTray() {
  if (!server) return;
  const open = server.settings.get('general').open;
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(resource('tray.png')));
    tray.on('click', openWindow);
  }
  tray.setToolTip(`PrintHub — ${open ? 'open for orders' : 'closed'}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open dashboard', click: openWindow },
      { label: open ? 'Close shop for orders' : 'Open shop for orders', enabled: server.settings.get('general').setupComplete, click: toggleOpen },
      { type: 'separator' },
      { label: 'Restart server', click: () => void restart() },
      { label: 'Quit PrintHub', click: () => void quit() },
    ]),
  );
}

function toggleOpen() {
  if (!server) return;
  const g = server.settings.get('general');
  server.settings.set('general', { ...g, open: !g.open });
  server.hub.publish('admin', 'settings', {});
}

function openWindow() {
  if (!server) return;
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 420,
    title: 'PrintHub',
    autoHideMenuBar: true,
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      additionalArguments: [`--printhub-token=${server.adminToken}`],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  const origin = server.url;
  void win.loadURL(`${origin}/admin`);
  // Only the local dashboard may load in the window; anything else opens in the browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) {
      e.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Closing destroys the renderer (frees ~100 MB); the server keeps running in the tray.
  win.on('closed', () => (win = null));
}

async function restart() {
  const s = server;
  server = null;
  await s?.close();
  await boot();
}

async function quit() {
  const pending = server?.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE state IN ('queued', 'processing', 'printing')`)?.n ?? 0;
  if (pending > 0) {
    const r = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Keep running', 'Quit anyway'],
      defaultId: 0,
      message: `${pending} document(s) are still waiting or printing.`,
      detail: 'They will continue when PrintHub starts again; anything mid-print will be marked for your review.',
    });
    if (r.response === 0) return;
  }
  quitting = true;
  await server?.close();
  app.quit();
}

/** A changed LAN address breaks the printed QR; tell the shopkeeper instead of failing silently. */
function checkAddress() {
  const now = lanAddresses()[0]?.address ?? null;
  if (now && lastAddress && now !== lastAddress) {
    notify('Network address changed', `This computer is now ${now}. Reprint the QR code from Shop & QR, or set a fixed address in your router.`);
  }
  if (now) lastAddress = now;
}

app.on('second-instance', openWindow);
// Stay alive in the tray when the window closes.
app.on('window-all-closed', () => {});
app.on('before-quit', (e) => {
  if (!quitting && server) {
    e.preventDefault();
    void quit();
  }
});

app.whenReady().then(() => {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  powerMonitor.on('resume', () => {
    checkAddress();
    void server?.printers.discover().then(() => server?.queue.kick()).catch(() => {});
  });
  // Cheap (no I/O): reads the OS interface table.
  setInterval(checkAddress, 10 * 60_000).unref();
  void boot();
});
