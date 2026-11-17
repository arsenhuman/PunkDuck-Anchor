#!/usr/bin/env node
// Build the self-contained Windows release:
//   dist/backup-manager-<version>-win-x64.zip      (node.exe + app + production node_modules + oauth-client.json)
//   dist/backup-manager-<version>-win-x64.zip.sha256
//   dist/install.ps1
//
// Environment:
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET   required (GitHub repository secrets in release.yml)
//   NODE_DIST_VERSION                                    Node.js version to bundle (default: the running one, must be 22.x)
//
// Runs on Windows and Linux.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const APP_FILES = ['bin', 'src', 'package.json', 'package-lock.json', 'README.md', 'RESTORE.md'];
const PACKAGING_FILES = ['backup-manager.cmd', 'backup-manager.env.template', 'install.ps1', 'uninstall.ps1'];

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Find fileName's hash in a SHASUMS256.txt and compare. Throws on mismatch or absence. */
export function verifyShasum(shasumsText, fileName, buf) {
  const line = shasumsText.split(/\r?\n/).find((l) => l.trim().split(/\s+/)[1] === fileName);
  if (!line) throw new Error(`${fileName} is not listed in SHASUMS256.txt`);
  const expected = line.trim().split(/\s+/)[0].toLowerCase();
  const actual = sha256(buf);
  if (expected !== actual) throw new Error(`SHA-256 mismatch for ${fileName}: expected ${expected}, got ${actual}`);
  return actual;
}

/** oauth-client.json in Google's "Desktop app" format. */
export function oauthClientJson(env) {
  const id = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const secret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!id || !secret) throw new Error('GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set');
  return JSON.stringify({ installed: { client_id: id, client_secret: secret } }, null, 2) + '\n';
}

export function nodeDistVersion(env = process.env, running = process.version) {
  const v = env.NODE_DIST_VERSION ? `v${env.NODE_DIST_VERSION.replace(/^v/, '')}` : running;
  if (!/^v22\.\d+\.\d+$/.test(v)) throw new Error(`bundled Node.js must be 22.x, got ${v} (set NODE_DIST_VERSION)`);
  return v;
}

/** cmd.exe and Windows PowerShell 5.1 expect CRLF; don't depend on how git checked the files out. */
export const toCrlf = (text) => text.replace(/\r?\n/g, '\r\n');

export const zipName = (version) => `backup-manager-${version}-win-x64.zip`;

/** "<hex>  <name>\n", the format sha256sum and install.ps1 read. */
export const shaLine = (hex, name) => `${hex}  ${name}\n`;

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function getNodeExe(version, cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const name = `node-${version}-win-x64.zip`;
  const cached = path.join(cacheDir, name);
  const shasums = (await download(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).toString('utf8');
  let zipBuf = fs.existsSync(cached) ? fs.readFileSync(cached) : null;
  if (!zipBuf) {
    console.log(`downloading ${name}`);
    zipBuf = await download(`https://nodejs.org/dist/${version}/${name}`);
  }
  verifyShasum(shasums, name, zipBuf); // also re-verifies a cached copy
  fs.writeFileSync(cached, zipBuf);
  const entry = new AdmZip(zipBuf).getEntry(`node-${version}-win-x64/node.exe`);
  if (!entry) throw new Error(`node.exe not found in ${name}`);
  return entry.getData();
}

function npmCiProduction(stageDir) {
  // shell: true so that npm.cmd resolves on Windows.
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: stageDir, stdio: 'inherit', shell: process.platform === 'win32',
  });
}

export async function build({ env = process.env, outDir = path.join(ROOT, 'dist') } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const oauth = oauthClientJson(env);
  const nodeVersion = nodeDistVersion(env);

  const stage = path.join(outDir, 'stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  for (const f of APP_FILES) fs.cpSync(path.join(ROOT, f), path.join(stage, f), { recursive: true });
  for (const f of PACKAGING_FILES) fs.writeFileSync(path.join(stage, f), toCrlf(fs.readFileSync(path.join(ROOT, 'packaging', f), 'utf8')));
  fs.writeFileSync(path.join(stage, 'oauth-client.json'), oauth);
  npmCiProduction(stage);
  fs.rmSync(path.join(stage, 'node_modules', '.bin'), { recursive: true, force: true }); // CLI shims, not needed
  fs.writeFileSync(path.join(stage, 'node.exe'), await getNodeExe(nodeVersion, path.join(outDir, '.cache')));

  const zip = new AdmZip();
  zip.addLocalFolder(stage);
  const name = zipName(pkg.version);
  const zipPath = path.join(outDir, name);
  zip.writeZip(zipPath);
  const hex = sha256(fs.readFileSync(zipPath));
  fs.writeFileSync(`${zipPath}.sha256`, shaLine(hex, name));
  fs.writeFileSync(path.join(outDir, 'install.ps1'), toCrlf(fs.readFileSync(path.join(ROOT, 'packaging', 'install.ps1'), 'utf8')));
  fs.rmSync(stage, { recursive: true, force: true });

  console.log(`built ${zipPath} (node ${nodeVersion}, sha256 ${hex})`);
  return { zipPath, sha256: hex };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  build().catch((err) => {
    console.error(`build failed: ${err.message}`);
    process.exitCode = 1;
  });
}
