// Build a portable Windows release with Node built-ins. No project data, tests, credentials or Git metadata.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const hash = (b) => createHash('sha256').update(b).digest('hex');
const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let crc = 0xffffffff; for (const c of b) crc = table[(crc ^ c) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; };

export function zipFiles(files) {
  const parts = []; const central = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path.replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(33, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    parts.push(header, name, packed); central.push(entry, name); offset += header.length + name.length + packed.length;
  }
  if (files.length > 65535 || offset > 0xffffffff) throw new Error('The release exceeds ZIP32 limits.');
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

export async function buildPackage({ appRoot = path.resolve(import.meta.dirname, '..'), outputDir = path.join(appRoot, 'release'), runtime = true, fetchImpl = fetch } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  const files = [];
  const add = (rel, data) => files.push({ path: rel, data: Buffer.isBuffer(data) ? data : Buffer.from(data) });
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(appRoot, rel), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('A release input is a symbolic link.');
      const file = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(file); else add(file, fs.readFileSync(path.join(appRoot, file)));
    }
  };
  for (const dir of ['backend', 'frontend', 'contracts']) walk(dir);
  for (const rel of ['scripts/circle.mjs', 'scripts/launch.mjs', 'scripts/launch.vbs', 'scripts/message.vbs', 'scripts/open-terminal.vbs', 'scripts/permission-hook.mjs', 'scripts/statusline-tap.mjs', 'scripts/install-package.ps1', 'scripts/uninstall-package.ps1']) add(rel, fs.readFileSync(path.join(appRoot, rel)));
  walk('scripts/widgets');
  add('scripts/supervise.mjs', fs.readFileSync(path.join(appRoot, 'scripts/supervise.mjs')));
  for (const rel of ['package.json', 'README.md', 'LICENSE', 'Install Circle Studio.cmd']) add(rel, fs.readFileSync(path.join(appRoot, rel)));
  add('Install for this user.cmd', '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\install-package.ps1"\r\npause\r\n');
  add('Open Circle Studio.cmd', '@echo off\r\nwscript.exe "%~dp0scripts\\launch.vbs"\r\n');
  if (runtime) {
    if (process.platform !== 'win32') throw new Error('Build a Windows runtime bundle on Windows, or pass --without-runtime for a source package.');
    const binary = fs.readFileSync(process.execPath);
    const releaseUrl = `https://nodejs.org/dist/v${process.versions.node}/SHASUMS256.txt`;
    const checks = await fetchImpl(releaseUrl, { signal: AbortSignal.timeout(30_000) });
    if (!checks.ok) throw new Error('Could not verify the bundled Node runtime against its official release.');
    const expected = (await checks.text()).split(/\r?\n/).find((l) => l.endsWith(`win-${process.arch}/node.exe`))?.split(/\s+/)[0];
    if (!expected || hash(binary) !== expected) throw new Error('The local Node binary does not match the official runtime checksum.');
    const license = await fetchImpl(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`, { signal: AbortSignal.timeout(30_000) });
    if (!license.ok) throw new Error('The Node license could not be downloaded; no runtime bundle was built.');
    add('runtime/node.exe', binary); add('runtime/NODE-LICENSE.txt', await license.text());
  }
  add('THIRD-PARTY-NOTICES.txt', runtime ? `This release includes Node.js ${process.version}. Its complete license notices are in runtime/NODE-LICENSE.txt. AI tools are installed separately and are not bundled.\n` : 'This package requires a separate Node.js 24+ installation. AI tools are not bundled.\n');
  const manifest = { schema: 'circle-release/1', version: pkg.version, platform: 'win32', arch: process.arch, node: runtime ? process.version : null, files: files.map((f) => ({ path: f.path, bytes: f.data.length, sha256: hash(f.data) })) };
  add('release-manifest.json', JSON.stringify(manifest, null, 2));
  const zip = zipFiles(files);
  fs.mkdirSync(outputDir, { recursive: true });
  const name = `circle-studio-${pkg.version}-windows-${process.arch}${runtime ? '' : '-node-required'}.zip`;
  const target = path.join(outputDir, name);
  fs.writeFileSync(target, zip, { flag: 'wx' });
  fs.writeFileSync(`${target}.sha256`, `${hash(zip)}  ${name}\n`, { flag: 'wx' });
  const info = { schema: 'circle-download/1', version: pkg.version, channel: 'stable', platform: 'Windows 10/11', arch: process.arch, filename: name, bytes: zip.length, sha256: hash(zip), runtime: runtime ? process.version : null, signed: false, download: 'https://github.com/Sarvesh-S-25/circle-studio/releases/download/v' + pkg.version + '/' + name, notes: 'https://github.com/Sarvesh-S-25/circle-studio/releases/tag/v' + pkg.version };
  fs.writeFileSync(path.join(outputDir, 'release-info.json'), JSON.stringify(info, null, 2), { flag: 'wx' });
  fs.writeFileSync(path.join(outputDir, 'DOWNLOAD.md'), '# Circle Studio ' + pkg.version + '\n\nRecommended Windows ' + process.arch + ' download: ' + name + ' (' + (zip.length / 1024 / 1024).toFixed(1) + ' MiB).\n\n' + (runtime ? 'Node is bundled; Node/npm/Git are not prerequisites. AI tools use their own CLI sign-ins.' : 'Developer package: requires Node 24 or newer.') + '\n\nExtract the ZIP, then run Install for this user.cmd. Open Circle Studio.cmd runs the portable copy. This build is unsigned. Publish the ZIP and its .sha256 file together before enabling its download link. release-info.json supplies version, size, checksum and links for the download website.\n', { flag: 'wx' });
  return { path: target, bytes: zip.length, files: files.length, sha256: hash(zip), runtime, signed: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const i = process.argv.indexOf('--output'); if (i >= 0 && !process.argv[i + 1]) throw new Error('--output needs a directory.'); console.log(JSON.stringify(await buildPackage({ runtime: !process.argv.includes('--without-runtime'), ...(i >= 0 ? { outputDir: path.resolve(process.argv[i + 1]) } : {}) }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
