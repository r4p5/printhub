// Downloads the portable SumatraPDF used to hand PDFs to the Windows spooler (GPLv3, shipped
// unmodified as a separate program). Check https://www.sumatrapdfreader.org/download-free-pdf-viewer
// for the current version and update VERSION.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = process.env.SUMATRA_VERSION ?? '3.5.2';
const url = `https://www.sumatrapdfreader.org/dl/rel/${VERSION}/SumatraPDF-${VERSION}-64.zip`;
const dir = fileURLToPath(new URL('../resources/', import.meta.url));
mkdirSync(dir, { recursive: true });

const res = await fetch(url);
if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
const zip = join(dir, 'sumatra.zip');
writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
// Windows 10+ ships bsdtar, which reads zip files.
execFileSync('tar', ['-xf', zip, '-C', dir]);
rmSync(zip);
const exe = readdirSync(dir).find((f) => /^SumatraPDF.*\.exe$/i.test(f));
if (!exe) throw new Error('SumatraPDF.exe not found in archive');
if (exe !== 'SumatraPDF.exe') renameSync(join(dir, exe), join(dir, 'SumatraPDF.exe'));
console.log(`SumatraPDF ${VERSION} -> resources/SumatraPDF.exe`);
