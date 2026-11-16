// Builds the hosted customer app and publishes it to the GitHub Pages repository.
// Uses your normal git credentials. Usage: node scripts/deploy-pages.mjs [repo-url]
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = process.argv[2] ?? 'https://github.com/r4p5/r4p5.github.io.git';
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

run('npm', ['run', 'build:pages', '-w', '@printhub/web']);
const dist = join(root, 'packages/web/dist-pages');
const work = mkdtempSync(join(tmpdir(), 'pages-'));
run('git', ['clone', '--depth', '1', repo, work]);
for (const f of readdirSync(work)) if (f !== '.git') rmSync(join(work, f), { recursive: true, force: true });
cpSync(dist, work, { recursive: true });
run('git', ['add', '-A'], work);
try {
  run('git', ['commit', '-m', 'Deploy PrintHub customer app'], work);
} catch {
  console.log('No changes to deploy.');
  process.exit(0);
}
run('git', ['push'], work);
rmSync(work, { recursive: true, force: true });
console.log('Deployed. GitHub Pages updates within a minute or two.');
