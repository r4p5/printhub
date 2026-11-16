import { parentPort } from 'node:worker_threads';
import { inspect, render } from './render.ts';

type Msg = { id: number; op: 'inspect'; path: string; kind: 'pdf' | 'jpg' | 'png' } | { id: number; op: 'render'; path: string; kind: 'pdf' | 'jpg' | 'png'; options: never; out: string };

parentPort!.on('message', async (msg: Msg) => {
  try {
    const result = msg.op === 'inspect' ? await inspect(msg.path, msg.kind) : await render(msg.path, msg.kind, msg.options, msg.out);
    parentPort!.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
