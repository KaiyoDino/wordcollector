// Builds the Windows installer with electron-builder. Usage: npm run dist
//
// Inside a OneDrive (or other synced) folder, the sync client locks freshly written
// files, which breaks electron-builder's renames, and it would upload ~300 MB per build.
// So in that case the output goes to a local folder outside the sync instead of dist/.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function outputDir() {
  const synced = /[\\/](OneDrive|Dropbox|iCloud ?Drive|Google Drive)[^\\/]*[\\/]/i.test(process.cwd() + path.sep);
  if (!synced) return path.resolve('dist');
  const base = process.env.LOCALAPPDATA || os.tmpdir();
  return path.join(base, 'WordCollector-build');
}

export function build() {
  const out = outputDir();
  fs.rmSync(out, { recursive: true, force: true });
  console.log(`Building into ${out}\n`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync('npx', ['electron-builder', '--win', '--publish', 'never', `--config.directories.output=${out}`], {
    stdio: 'inherit', env, shell: process.platform === 'win32',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = build();
  console.log(`\nInstaller: ${out}`);
}
