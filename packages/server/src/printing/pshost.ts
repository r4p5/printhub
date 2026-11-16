import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

const IDLE_MS = 60_000;
const TIMEOUT_MS = 30_000;

// Reads base64 commands line by line and answers with one base64 line each, so arbitrary
// output never breaks framing. Encoded as UTF-16LE for -EncodedCommand to avoid quoting.
const LOOP = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line.Split(' ', 2)
  try {
    $code = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
    $r = (Invoke-Expression $code | Out-String)
    [Console]::Out.WriteLine('OK ' + $parts[0] + ' ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($r)))
  } catch {
    [Console]::Out.WriteLine('ERR ' + $parts[0] + ' ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.Message)))
  }
  [Console]::Out.Flush()
}`;

/**
 * One long-lived PowerShell process shared by all spooler queries. Starting PowerShell costs
 * ~0.5-1s of CPU and ~60MB, so polling via fresh processes would be wasteful; this host is
 * started on first use and exits after a minute without commands.
 */
export class PsHost {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private seq = 0;
  private idle: NodeJS.Timeout | null = null;

  run(script: string): Promise<string> {
    const proc = this.ensure();
    const id = ++this.seq;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('PowerShell command timed out'));
        this.kill();
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(`${id} ${Buffer.from(script, 'utf8').toString('base64')}\n`);
    });
  }

  async close() {
    this.kill();
  }

  private ensure() {
    if (this.proc) return this.proc;
    const proc = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(LOOP, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: 'pipe' },
    );
    proc.stderr.resume(); // drain so the pipe never blocks
    createInterface({ input: proc.stdout }).on('line', (line) => {
      const m = /^(OK|ERR) (\d+) (.*)$/.exec(line);
      if (!m) return;
      const p = this.pending.get(Number(m[2]));
      if (!p) return;
      this.pending.delete(Number(m[2]));
      clearTimeout(p.timer);
      const text = Buffer.from(m[3]!, 'base64').toString('utf8');
      if (m[1] === 'OK') p.resolve(text);
      else p.reject(new Error(text.trim()));
      if (this.pending.size === 0) this.scheduleIdle();
    });
    const onGone = () => {
      if (this.proc !== proc) return;
      this.proc = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('PowerShell exited'));
      }
      this.pending.clear();
    };
    proc.on('exit', onGone);
    proc.on('error', onGone);
    this.proc = proc;
    return proc;
  }

  private scheduleIdle() {
    this.idle = setTimeout(() => this.kill(), IDLE_MS);
    this.idle.unref();
  }

  private kill() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    p.stdin.end();
    p.kill();
  }
}
