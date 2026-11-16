// Exposes only the admin token to the dashboard; no Node APIs reach the page.
const { contextBridge } = require('electron');

const arg = process.argv.find((a: string) => a.startsWith('--printhub-token='));
contextBridge.exposeInMainWorld('printhub', { adminToken: arg ? arg.slice('--printhub-token='.length) : '' });
