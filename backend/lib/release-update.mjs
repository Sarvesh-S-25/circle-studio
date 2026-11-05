// Packaged updates are downloaded to an isolated staging folder and verified before installation.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { cleanEnv, killTree } from './run.mjs';

const REPO = 'Sarvesh-S-25/circle-studio';
const MAX_ZIP = 150 * 1024 * 1024;
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
async function smallResponse(response, max = 1024 * 1024) {
  if (!response.ok) throw new Error(`Release server returned ${response.status}.`);
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > max) throw new Error('Release metadata exceeds its size limit.'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks).toString('utf8');
}
export async function checkRelease(appRoot, { fetchImpl = fetch } = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
  const base = { at: new Date().toISOString(), version, mode: 'release', channel: 'stable', signed: false, source: `https://github.com/${REPO}/releases`, available: false, canUpdate: false };
  try {
    const data = JSON.parse(await smallResponse(await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CircleStudio' }, signal: AbortSignal.timeout(15000) })));
    const next = String(data.tag_name || '').replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(next) || data.draft || data.prerelease) throw new Error('No supported stable release was found.');
    const name = `circle-studio-${next}-windows-${process.arch}.zip`;
    const asset = data.assets?.find((a) => a.name === name);
    const checksum = data.assets?.find((a) => a.name === `${name}.sha256`);
    const allowed = (u) => typeof u === 'string' && u.startsWith(`https://github.com/${REPO}/releases/download/`) && !new URL(u).username && !new URL(u).password;
    if (!asset || !checksum || !allowed(asset.browser_download_url) || !allowed(checksum.browser_download_url) || asset.size > MAX_ZIP) throw new Error('The release is missing its runtime ZIP or checksum.');
    return { ...base, nextVersion: next, available: newer(next, version), canUpdate: newer(next, version), bytes: asset.size, asset: asset.browser_download_url, checksum: checksum.browser_download_url, reason: 'Downloaded from the project’s GitHub release over HTTPS and verified by checksum and file manifest. This channel is currently unsigned; a checksum is not proof of publisher identity.' };
  } catch (error) { return { ...base, reason: `Release check unavailable: ${error.message}` }; }
}

// Check central-directory paths, entry types and declared uncompressed size before invoking Windows extraction.
export function validateReleaseZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size; const tail = Buffer.alloc(Math.min(size, 65557));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error('Unsupported release archive.');
    const count = tail.readUInt16LE(end + 10), bytes = tail.readUInt32LE(end + 12), start = tail.readUInt32LE(end + 16);
    if (!count || count > 5000 || bytes > 4 * 1024 * 1024 || start + bytes > size - tail.length + end) throw new Error('Release archive limits exceeded.');
    const directory = Buffer.alloc(bytes); fs.readSync(fd, directory, 0, bytes, start);
    const names = new Set(); let pos = 0, unpacked = 0;
    for (let i = 0; i < count; i++) {
      if (pos + 46 > bytes || directory.readUInt32LE(pos) !== 0x02014b50) throw new Error('Invalid release directory.');
      const length = directory.readUInt16LE(pos + 28), extra = directory.readUInt16LE(pos + 30), comment = directory.readUInt16LE(pos + 32);
      const name = directory.subarray(pos + 46, pos + 46 + length).toString('utf8');
      const kind = directory.readUInt32LE(pos + 38) >>> 16 & 0xf000;
      if (!name || /^[\/]|[\\:]|(^|\/)\.\.?($|\/)/.test(name) || names.has(name.toLowerCase()) || kind === 0xa000 || directory.readUInt16LE(pos + 8) & 1 || ![0, 8].includes(directory.readUInt16LE(pos + 10))) throw new Error('Unsafe release archive entry.');
      names.add(name.toLowerCase()); unpacked += directory.readUInt32LE(pos + 24);
      if (unpacked > 512 * 1024 * 1024) throw new Error('Release archive expands beyond its size limit.');
      pos += 46 + length + extra + comment;
    }
    if (pos !== bytes || !names.has('release-manifest.json') || !names.has('scripts/install-package.ps1')) throw new Error('Incomplete release archive.');
    return { entries: count, unpacked };
  } finally { fs.closeSync(fd); }
}

const powershell = (args, env) => new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { env: cleanEnv(env), windowsHide: true, timeout: 120000, maxBuffer: 65536 }, (error) => error ? reject(new Error('The staged release could not be verified or installed. Previous code and data remain available.')) : resolve()));

async function probeLaunch(root, stage) {
  const probe = path.join(stage, 'probe'); fs.mkdirSync(probe);
  fs.writeFileSync(path.join(probe, 'settings.json'), JSON.stringify({ desktopAsks: false, desktopWidgets: false, updates: { check: 'off', autoRestart: false } }));
  const listener = net.createServer(); await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  const child = spawn(path.join(root, 'runtime/node.exe'), [path.join(root, 'backend/server.mjs')], { env: cleanEnv({ ...process.env, CIRCLE_RELEASE_PROBE: '1', CIRCLE_PORT: String(port), CIRCLE_DATA: probe, CIRCLE_NO_OPEN: '1', CIRCLE_USER_HOME: path.join(probe, 'home'), CIRCLE_CLAUDE_HOME: path.join(probe, 'home', '.claude'), CIRCLE_CODEX_HOME: path.join(probe, 'home', '.codex') }), stdio: 'ignore', windowsHide: true });
  let failed = false; child.on('error', () => { failed = true; });
  try {
    for (let i = 0; i < 40; i++) {
      if (failed || child.exitCode !== null) throw new Error('The staged release failed its isolated launch check.');
      try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) }); const health = await r.json(); if (health.ok && path.resolve(health.dataDir) === path.resolve(probe)) return; } catch { /* still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('The staged release did not become healthy; the previous version remains active.');
  } finally { if (child.pid && child.exitCode === null) await killTree(child); }
}
export { probeLaunch as verifyStagedLaunch };

export async function applyRelease(appRoot, { dataDir, busy = () => false, fetchImpl = fetch, extractImpl, installImpl, probeImpl = probeLaunch } = {}) {
  if (busy()) throw new Error('Finish running work and pending requests before updating.');
  const release = await checkRelease(appRoot, { fetchImpl });
  if (!release.available || !release.canUpdate) throw new Error(release.reason || 'Already up to date.');
  const expected = (await smallResponse(await fetchImpl(release.checksum, { signal: AbortSignal.timeout(15000) }), 4096)).trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error('Invalid release checksum.');
  const stage = path.join(dataDir, 'updates', randomUUID()); fs.mkdirSync(stage, { recursive: true });
  const archive = path.join(stage, 'release.zip');
  const response = await fetchImpl(release.asset, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('Release download failed. Previous code and data are unchanged.');
  const hash = createHash('sha256'); const fd = fs.openSync(archive, 'wx'); let bytes = 0;
  try { for await (const chunk of response.body) { bytes += chunk.length; if (bytes > MAX_ZIP) throw new Error('Release download exceeds its size limit.'); hash.update(chunk); let offset = 0; while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset); } } finally { fs.closeSync(fd); }
  if (hash.digest('hex') !== expected.toLowerCase()) throw new Error('Release checksum mismatch. Previous code and data are unchanged.');
  validateReleaseZip(archive);
  const source = path.join(stage, 'source');
  if (extractImpl) await extractImpl(archive, source);
  else await powershell(['-Command', 'Expand-Archive -LiteralPath $env:CIRCLE_UPDATE_ZIP -DestinationPath $env:CIRCLE_UPDATE_DEST'], { ...process.env, CIRCLE_UPDATE_ZIP: archive, CIRCLE_UPDATE_DEST: source });
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'release-manifest.json'), 'utf8'));
  if (manifest.version !== release.nextVersion || manifest.platform !== 'win32' || manifest.arch !== process.arch) throw new Error('Release metadata does not match the update.');
  const installed = fs.existsSync(path.join(appRoot, 'installation.json'));
  const installRoot = installed ? path.dirname(appRoot) : path.join(dataDir, 'installed');
  const nextRoot = path.join(installRoot, `app-${release.nextVersion}`);
  const install = installImpl || ((stageOnly) => powershell(['-File', path.join(source, 'scripts/install-package.ps1'), '-NoOpen', '-Repair', ...(stageOnly ? ['-StageOnly'] : [])], { ...process.env, CIRCLE_INSTALL_ROOT: installRoot, CIRCLE_INSTALL_DATA: dataDir }));
  await install(true, nextRoot);
  await probeImpl(nextRoot, stage);
  if (busy()) throw new Error('New work started while downloading. The verified update is staged; finish that work before activating.');
  await install(false, nextRoot);
  return { ok: true, version: release.nextVersion, nextRoot, staged: stage, previousRoot: appRoot, message: 'Release verified, isolated launch passed and installation activated. Previous code and shared data were preserved.' };
}
