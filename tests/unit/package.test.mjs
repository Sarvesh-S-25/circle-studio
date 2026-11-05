import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildPackage } from '../../scripts/package.mjs';
import { tempDir, rmDir } from '../helpers/project.mjs';

test('release ZIP contains runtime files and integrity manifest, excludes application data and development fixtures', async () => {
  const dir = tempDir();
  try {
    const result = await buildPackage({ outputDir: dir, runtime: false });
    const zip = fs.readFileSync(result.path); const files = new Map(); let pos = 0;
    while (zip.readUInt32LE(pos) === 0x04034b50) {
      const length = zip.readUInt32LE(pos + 18); const nameLen = zip.readUInt16LE(pos + 26); const extraLen = zip.readUInt16LE(pos + 28);
      const name = zip.subarray(pos + 30, pos + 30 + nameLen).toString(); const start = pos + 30 + nameLen + extraLen;
      files.set(name, inflateRawSync(zip.subarray(start, start + length))); pos = start + length;
    }
    assert.equal(zip.readUInt32LE(pos), 0x02014b50);
    const manifest = JSON.parse(files.get('release-manifest.json'));
    assert.equal(manifest.schema, 'circle-release/1');
    assert.ok(files.has('backend/server.mjs') && files.has('frontend/index.html') && files.has('scripts/install-package.ps1'));
    assert.ok([...files.keys()].every((f) => !/^(data|tests|release|\.git)\//.test(f)));
    assert.ok(!files.has('installation.json') && !files.has('scripts/demo.mjs'));
    for (const entry of manifest.files) assert.equal(createHash('sha256').update(files.get(entry.path)).digest('hex'), entry.sha256, entry.path);
    assert.match(fs.readFileSync(`${result.path}.sha256`, 'utf8'), new RegExp(result.sha256));
    if (process.platform === 'win32') {
      const source = path.join(dir, 'extracted'); const install = path.join(dir, 'installed');
      for (const [rel, data] of files) { const target = path.join(source, rel); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data); }
      fs.mkdirSync(path.join(install, 'data'), { recursive: true }); fs.writeFileSync(path.join(install, 'data', 'keep.txt'), 'existing user data');
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(source, 'scripts', 'install-package.ps1'), '-StageOnly'];
      const options = { env: { ...process.env, CIRCLE_INSTALL_ROOT: install }, encoding: 'utf8', windowsHide: true };
      assert.match(execFileSync('powershell.exe', args, options), /Verified and staged/);
      const target = path.join(install, `app-${manifest.version}`);
      assert.equal(fs.readFileSync(path.join(target, 'backend', 'server.mjs'), 'utf8'), files.get('backend/server.mjs').toString());
      assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'installation.json'), 'utf8').replace(/^\uFEFF/, '')).dataDir, path.join(install, 'data'));
      assert.equal(fs.readFileSync(path.join(install, 'data', 'keep.txt'), 'utf8'), 'existing user data');
      assert.throws(() => execFileSync('powershell.exe', args, { ...options, stdio: 'pipe' }), /already installed/);
      assert.match(execFileSync('powershell.exe', [...args, '-Repair'], options), /Verified and staged/);
      fs.appendFileSync(path.join(target, 'frontend', 'index.html'), 'dummy damage');
      assert.match(execFileSync('powershell.exe', [...args, '-Repair'], options), /Verified and staged/);
      assert.equal(fs.readFileSync(path.join(target, 'frontend', 'index.html'), 'utf8'), files.get('frontend/index.html').toString(), 'repair restores damaged code from the verified package');
      const uninstall = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-File', path.join(target, 'scripts/uninstall-package.ps1'), '-Preview'], options));
      assert.equal(uninstall.removesData, false);
      assert.equal(uninstall.data, path.join(install, 'data'));
      assert.match(execFileSync('powershell.exe', [...args, '-ActivateVersion', manifest.version], options), /Verified and staged/);
      fs.appendFileSync(path.join(source, 'backend', 'server.mjs'), 'tamper');
      assert.throws(() => execFileSync('powershell.exe', args, { ...options, env: { ...options.env, CIRCLE_INSTALL_ROOT: path.join(dir, 'rejected') }, stdio: 'pipe' }), /Integrity check failed/);
      assert.equal(fs.existsSync(path.join(dir, 'rejected')), false, 'failed integrity creates no installation');
    }
    await assert.rejects(buildPackage({ outputDir: dir, runtime: false }), /EEXIST/);
  } finally { rmDir(dir); }
});
