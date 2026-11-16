import { startServer } from './app.ts';

const app = await startServer();
console.log(`Admin token: ${app.adminToken}`);

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    process.exit(0);
  });
}
