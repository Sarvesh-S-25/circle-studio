import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipFiles } from '../../scripts/package.mjs';
import { checkRelease, applyRelease, validateReleaseZip } from '../../backend/lib/release-update.mjs';
import { tempDir, rmDir } from '../helpers/project.mjs';

test('packaged updates reject unsafe archives and preserve current data on checksum or launch failure', async () => {
  const root = tempDir();
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.3.0' }));
    const manifest = { schema: 'circle-release/1', version: '1.4.0', platform: 'win32', arch: process.arch, files: [] };
    const zip = zipFiles([{ path: 'release-manifest.json', data: JSON.stringify(manifest) }, { path: 'scripts/install-package.ps1', data: 'dummy' }]);
    const checksum = createHash('sha256').update(zip).digest('hex');
    const archive = path.join(root, 'test.zip'); fs.writeFileSync(archive, zip);
    assert.equal(validateReleaseZip(archive).entries, 2);
    fs.writeFileSync(archive, zipFiles([{ path: '../escape', data: 'unsafe' }]));
    assert.throws(() => validateReleaseZip(archive), /Unsafe/);
    const dataDir = path.join(root, 'data'); fs.mkdirSync(dataDir); fs.writeFileSync(path.join(dataDir, 'keep.json'), 'preserved');
    const url = 'https://github.com/Sarvesh-S-25/circle-studio/releases/download/v1.4.0/circle-studio-1.4.0-windows-' + process.arch + '.zip';
    let corrupt = false;
    const fetchImpl = async (u) => new Response(String(u).includes('api.github.com') ? JSON.stringify({ tag_name: 'v1.4.0', assets: [{ name: path.basename(url), browser_download_url: url, size: zip.length }, { name: path.basename(url) + '.sha256', browser_download_url: url + '.sha256' }] }) : String(u).endsWith('.sha256') ? (corrupt ? '0'.repeat(64) : checksum) : zip);
    assert.equal((await checkRelease(root, { fetchImpl })).available, true);
    const calls = [];
    const options = { dataDir, fetchImpl, extractImpl: async (_zip, dest) => { calls.push('extract'); fs.mkdirSync(dest); fs.writeFileSync(path.join(dest, 'release-manifest.json'), JSON.stringify(manifest)); }, installImpl: async (stage) => { calls.push(stage ? 'stage' : 'activate'); }, probeImpl: async () => { calls.push('probe'); throw new Error('Dummy launch failed'); } };
    await assert.rejects(applyRelease(root, options), /Dummy launch failed/);
    assert.deepEqual(calls, ['extract', 'stage', 'probe']);
    assert.equal(fs.readFileSync(path.join(dataDir, 'keep.json'), 'utf8'), 'preserved');
    calls.length = 0; corrupt = true;
    await assert.rejects(applyRelease(root, options), /checksum mismatch/);
    assert.deepEqual(calls, []);
    corrupt = false;
    const result = await applyRelease(root, { ...options, probeImpl: async () => calls.push('probe') });
    assert.equal(result.ok, true); assert.deepEqual(calls, ['extract', 'stage', 'probe', 'activate']);
    assert.equal(fs.readFileSync(path.join(dataDir, 'keep.json'), 'utf8'), 'preserved');
    await assert.rejects(applyRelease(root, { ...options, busy: () => true }), /Finish running/);
  } finally { rmDir(root); }
});
