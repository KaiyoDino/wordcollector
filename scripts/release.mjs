// Builds the Windows installer and publishes it as a GitHub Release, which installed
// copies of the app pick up as an update. Usage (see README → "Releasing an update"):
//   npm version patch      (or minor / major: bumps the version, commits and tags)
//   git push --follow-tags
//   npm run release
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from './build.mjs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = pkg.version;
const tag = `v${version}`;
const { owner, repo } = pkg.build.publish[0];

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const fail = (message) => {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
};
const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) fail(`${cmd} ${args.join(' ')} failed`);
};

// 1. The release must match exactly what's on GitHub.
if (git('status', '--porcelain')) fail('You have uncommitted changes. Commit them first.');
git('fetch', '--quiet', 'origin');
const head = git('rev-parse', 'HEAD');
let upstream;
try { upstream = git('rev-parse', '@{u}'); } catch { fail('This branch isn’t pushed to GitHub yet. Run: git push -u origin HEAD'); }
if (head !== upstream) fail('Your latest commits aren’t on GitHub yet. Run: git push --follow-tags');

const existing = spawnSync('gh', ['release', 'view', tag, '--repo', `${owner}/${repo}`], { stdio: 'ignore', shell: process.platform === 'win32' });
if (existing.status === 0) {
  fail(`Release ${tag} already exists. Bump the version first: npm version patch (then git push --follow-tags)`);
}

// 2. Build the installer and the update metadata (latest.yml) the app checks.
console.log(`\nBuilding Word Collector ${version}…\n`);
const out = build();

const installer = `Word-Collector-Setup-${version}.exe`;
const assets = [installer, `${installer}.blockmap`, 'latest.yml'].map((f) => path.join(out, f));
for (const file of assets) if (!fs.existsSync(file)) fail(`Expected build output is missing: ${file}`);

// 3. Publish. Installed apps see the new release within a few hours (or on next start).
console.log(`\nPublishing ${tag} to github.com/${owner}/${repo}…\n`);
run('gh', [
  'release', 'create', tag, ...assets,
  '--repo', `${owner}/${repo}`,
  '--target', head,
  '--title', `Word Collector ${version}`,
  '--notes', `Download **${installer}** below to install Word Collector on Windows.\n\nAlready installed? The app updates itself; restart it when it says an update is ready.`,
]);
console.log(`\n✔ Released ${tag}. Share this page: https://github.com/${owner}/${repo}/releases/latest\n`);
