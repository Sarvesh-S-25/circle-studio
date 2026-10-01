import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseGithubUrl, createGithub } from '../../backend/lib/github.mjs';
import { Library, slugify, ensureFrontMatter } from '../../backend/lib/skills.mjs';
import { Store } from '../../backend/lib/store.mjs';
import { tempDir, rmDir } from '../helpers/project.mjs';

test('parseGithubUrl accepts the documented shapes', () => {
  assert.deepEqual(parseGithubUrl('https://github.com/anthropics/skills'), { owner: 'anthropics', repo: 'skills', kind: 'repo', rest: [] });
  assert.equal(parseGithubUrl('https://www.github.com/a/b.git/').repo, 'b');
  assert.deepEqual(parseGithubUrl('https://github.com/a/b/tree/main/skills').rest, ['main', 'skills']);
  assert.equal(parseGithubUrl('  https://github.com/a/b/blob/main/x/SKILL.md ').kind, 'blob');
});

test('parseGithubUrl rejects everything else', () => {
  for (const bad of [
    'http://github.com/a/b', 'https://gitlab.com/a/b', 'https://raw.githubusercontent.com/a/b/main/x', 'https://gist.github.com/a/b',
    'https://user@github.com/a/b', 'https://user:pw@github.com/a/b', 'https://github.com:8443/a/b', 'https://127.0.0.1/a/b', 'git@github.com:a/b',
    'https://github.com/a', 'https://github.com/', 'https://github.com/a/b?path=../../x', 'https://github.com/a/../b', 'https://github.com/a/b/issues/1',
    'https://github.com/a/b/tree/', 'ftp://github.com/a/b', 'https://github.com/a/b\\c', `https://github.com/a/${'x'.repeat(2100)}`, '', 'not a url',
    'https://github.com.evil.test/a/b', 'https://github.com/a/b/tree/main/../../x',
  ]) {
    assert.throws(() => parseGithubUrl(bad), /./, bad.slice(0, 60));
  }
});

function fakeGithub(files, { tree, onRequest } = {}) {
  const entries = tree || Object.entries(files).map(([p, c]) => ({ path: p, type: 'blob', mode: '100644', size: Buffer.byteLength(c) }));
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    onRequest?.(url);
    const h = { 'x-ratelimit-remaining': '55', 'x-ratelimit-reset': '1900000000' };
    if (url === 'https://api.github.com/repos/o/r') return new Response(JSON.stringify({ default_branch: 'main', archived: false }), { headers: h });
    if (url.startsWith('https://api.github.com/repos/o/r/git/trees/main?recursive=1')) return new Response(JSON.stringify({ sha: 'x', truncated: false, tree: entries }), { headers: h });
    if (url.startsWith('https://api.github.com/')) return new Response('{"message":"Not Found"}', { status: 404, headers: h });
    if (url.startsWith('https://raw.githubusercontent.com/o/r/main/')) {
      const p = decodeURIComponent(url.slice('https://raw.githubusercontent.com/o/r/main/'.length));
      if (p in files) return new Response(files[p]);
    }
    return new Response('nope', { status: 404 });
  };
  return { fetchImpl, seen };
}

const FILES = {
  'skills/alpha/SKILL.md': '---\nname: Alpha Skill\ndescription: >\n  Does alpha\n  things.\nmetadata:\n  a: 1\n---\nBody',
  'skills/alpha/references/guide.md': 'guide',
  'skills/beta/SKILL.md': '# No front matter here\n\nJust text.',
  'skills/gamma/SKILL.md': '---\nname: gamma\ndescription: Has an illegal file\n---\n',
  'skills/gamma/<Name>.swift': 'x',
  'README.md': 'readme',
};

test('scan lists skills, handles block scalars, missing front matter and illegal paths', async () => {
  const dir = tempDir();
  try {
    const store = new Store(dir);
    const lib = new Library({ store });
    const { fetchImpl, seen } = fakeGithub(FILES);
    const gh = createGithub({ fetchImpl, libraryDirLength: lib.dir.length, exists: (k) => lib.has(k) });
    const res = await gh.scan('https://github.com/o/r');
    assert.equal(res.repo.ref, 'main');
    const by = Object.fromEntries(res.skills.map((s) => [s.key, s]));
    assert.equal(by.alpha.description, 'Does alpha things.');
    assert.equal(by.alpha.declaredName, 'Alpha Skill');
    assert.equal(by.alpha.files, 2);
    assert.equal(by.beta.needsWrap, true);
    assert.match(by.gamma.skipped, /illegal characters/);
    assert.equal(res.rate.remaining, 55);
    assert.ok(seen.every((u) => u.startsWith('https://api.github.com/') || u.startsWith('https://raw.githubusercontent.com/')));
  } finally { rmDir(dir); }
});

test('fetch imports all-or-nothing, wraps front matter, reports conflicts, skips symlinks', async () => {
  const dir = tempDir();
  try {
    const store = new Store(dir);
    const lib = new Library({ store });
    const tree = [
      ...Object.entries(FILES).map(([p, c]) => ({ path: p, type: 'blob', mode: '100644', size: Buffer.byteLength(c) })),
      { path: 'skills/alpha/link.md', type: 'blob', mode: '120000', size: 20 },
      { path: 'sub', type: 'commit', mode: '160000' },
    ];
    const { fetchImpl } = fakeGithub(FILES, { tree });
    const gh = createGithub({ fetchImpl, libraryDirLength: lib.dir.length });
    const url = 'https://github.com/o/r';
    const r1 = await gh.fetch({ url, ref: 'main', picks: ['skills/alpha', 'skills/beta', 'skills/gamma', 'skills/missing'], library: lib });
    assert.deepEqual(r1.imported.sort(), ['alpha', 'beta']);
    assert.equal(r1.skipped.length, 2);
    assert.ok(fs.existsSync(path.join(lib.dir, 'alpha', 'references', 'guide.md')));
    assert.ok(!fs.existsSync(path.join(lib.dir, 'alpha', 'link.md')), 'symlink entry not imported');
    assert.ok(!fs.existsSync(path.join(lib.dir, 'gamma')), 'nothing partial on disk');
    assert.match(fs.readFileSync(path.join(lib.dir, 'beta', 'SKILL.md'), 'utf8'), /^---\nname: beta\ndescription: "No front matter here"\n---/);
    assert.equal(lib.list().find((s) => s.name === 'alpha').source.type, 'github');
    const r2 = await gh.fetch({ url, ref: 'main', picks: ['skills/alpha'], library: lib });
    assert.equal(r2.conflicts.length, 1);
    assert.equal(r2.conflicts[0].suggestion, 'alpha-2');
    const r3 = await gh.fetch({ url, ref: 'main', picks: ['skills/alpha'], overwrite: true, library: lib });
    assert.deepEqual(r3.imported, ['alpha']);
    assert.ok(fs.readdirSync(lib.dir).every((n) => !n.startsWith('.stage') && !n.includes('.old-')), 'no staging leftovers');
  } finally { rmDir(dir); }
});

test('rate limit and not-found become clean errors', async () => {
  const gh1 = createGithub({ fetchImpl: async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' } }) });
  await assert.rejects(() => gh1.scan('https://github.com/o/r'), (e) => e.code === 'upstream' && Boolean(e.detail.resetAt));
  const gh2 = createGithub({ fetchImpl: async () => new Response('{}', { status: 404 }) });
  await assert.rejects(() => gh2.scan('https://github.com/o/r'), (e) => e.code === 'not_found' && /private/.test(e.message));
  const gh3 = createGithub({ fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(() => gh3.scan('https://github.com/o/r'), (e) => e.code === 'upstream');
});

test('library: save, list, use counter, remove, validation warnings', () => {
  const dir = tempDir();
  try {
    const lib = new Library({ store: new Store(dir) });
    const r = lib.save('my-skill', '---\nname: my-skill\ndescription: Mine.\n---\nHi');
    assert.equal(r.created, true);
    assert.deepEqual(r.warnings, []);
    assert.ok(lib.save('other', 'no front matter').warnings.length > 0);
    assert.ok(lib.save('third', '---\nname: wrong\ndescription: d\n---\n').warnings.some((w) => /folder is "third"/.test(w)));
    lib.use('my-skill'); lib.use('my-skill'); lib.use('other');
    assert.deepEqual(lib.mostUsed().map((s) => [s.name, s.uses]), [['my-skill', 2], ['other', 1]]);
    assert.throws(() => lib.save('Bad Name', 'x'), /Invalid/);
    assert.throws(() => lib.get('nope'), /No skill/);
    lib.remove('other');
    assert.equal(lib.has('other'), false);
    assert.equal(lib.get('my-skill').skillMd.includes('Hi'), true);
  } finally { rmDir(dir); }
});

test('library.importDropped: folder with skills, single .md, project hint', () => {
  const dir = tempDir();
  try {
    const lib = new Library({ store: new Store(dir) });
    const b = (s) => Buffer.from(s);
    const r1 = lib.importDropped([
      { path: 'pack/one/SKILL.md', buffer: b('---\nname: one\ndescription: d\n---\n') },
      { path: 'pack/one/ref.txt', buffer: b('r') },
      { path: 'pack/two/SKILL.md', buffer: b('---\nname: two\ndescription: d\n---\n') },
      { path: 'pack/README.md', buffer: b('ignored') },
    ]);
    assert.deepEqual(r1.imported.sort(), ['one', 'two']);
    assert.ok(fs.existsSync(path.join(lib.dir, 'one', 'ref.txt')));
    const r2 = lib.importDropped([{ path: 'My Cool Prompt.md', buffer: b('# Cool prompt\n\nDo it.') }]);
    assert.deepEqual(r2.imported, ['my-cool-prompt']);
    assert.match(fs.readFileSync(path.join(lib.dir, 'my-cool-prompt', 'SKILL.md'), 'utf8'), /^---\nname: my-cool-prompt/);
    const r3 = lib.importDropped([{ path: 'pack/one/SKILL.md', buffer: b('---\nname: one\ndescription: d\n---\n') }]);
    assert.equal(r3.conflicts.length, 1);
    const r4 = lib.importDropped([{ path: 'proj/models.json', buffer: b('{}') }, { path: 'proj/.claude/agents/x.md', buffer: b('x') }]);
    assert.match(r4.hint, /project folder/);
    const r5 = lib.importDropped([{ path: 'root/SKILL.md', buffer: b('---\nname: r\ndescription: d\n---\n') }, { path: 'root/../evil/SKILL.md', buffer: b('x') }]);
    assert.ok(r5.skipped.length + r5.imported.length >= 1);
    assert.ok(!fs.existsSync(path.join(dir, 'library', 'evil')));
  } finally { rmDir(dir); }
});

test('slugify and ensureFrontMatter', () => {
  assert.equal(slugify('  Ahrefs Automation!! '), 'ahrefs-automation');
  assert.equal(slugify('-21risk-automation'), '21risk-automation');
  assert.equal(slugify('anthropic_administrator-automation'), 'anthropic-administrator-automation');
  assert.equal(slugify('Café'), 'cafe');
  assert.equal(ensureFrontMatter('---\nname: x\n---\n', 'k').wrapped, false);
  assert.match(ensureFrontMatter('# Title "q"\n', 'k').text, /description: "Title \\"q\\""/);
});
