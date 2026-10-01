// Connections: what each engine is connected to (MCP servers), whether it is healthy, a local security check, and
// the key vault. Everything is read on this PC; a remote server is only contacted when you press Check.
import { api } from '../api.js';
import { h, icon, timeAgo, plural } from '../dom.js';
import { state } from '../state.js';
import { reviewChanges } from '../components/diffreview.js';
import { confirmDialog, openModal, toast } from '../components/overlay.js';

const ENGINE = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', copilot: 'Copilot', vscode: 'VS Code' };
const HEALTH = { ok: ['ok', 'Healthy'], broken: ['danger', 'Broken'], unknown: ['info', 'Not checked'], off: ['quiet', 'Off'] };
const suggestName = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'K_$1').slice(0, 60) || 'API_KEY';

export async function mount(el, ctx) {
  let projectId = ctx.params.projectId || '';
  let data = null;
  let keys = [];
  const health = new Map();
  const list = h('div', { class: 'cs-stack cs-stack--loose' });

  const picker = h('select', { class: 'cs-select cs-select--small', 'aria-label': 'Show connections for', onchange: (e) => { projectId = e.target.value; location.hash = projectId ? `#/connections/${projectId}` : '#/connections'; } },
    h('option', { value: '' }, 'This PC (every engine, every folder)'),
    state.projects.filter((p) => p.exists).map((p) => h('option', { value: p.id, selected: p.id === projectId || undefined }, p.name)));

  async function load() {
    list.replaceChildren(h('div', { class: 'cs-loading' }, icon('spinner', 'm'), 'Reading the connector files...'));
    try {
      [data, keys] = await Promise.all([api.connections(projectId), api.vault().then((v) => v.keys)]);
    } catch (e) { list.replaceChildren(h('p', { class: 'cs-soft' }, e.message)); return; }
    draw();
    for (const s of data.servers) if (s.transport === 'stdio' || /\/\/(localhost|127\.)/.test(s.url || '')) check(s, false);
  }

  async function check(s, remote) {
    health.set(s.id, { status: 'checking', text: 'Checking...' });
    draw();
    try { health.set(s.id, (await api.checkConnection({ id: s.id, projectId: projectId || undefined, remote })).health); } catch (e) { health.set(s.id, { status: 'broken', text: e.message }); }
    draw();
  }

  async function moveToVault(f) {
    const s = data.servers.find((x) => x.id === f.server);
    if (!s) return;
    const entry = s.plainSecrets[0];
    const [field, key] = entry.startsWith('header ') ? ['headers', entry.slice(7)] : ['env', entry.replace(/^env /, '')];
    const name = suggestName(field === 'env' ? key : `${s.name}_${key}`);
    if (!(await confirmDialog({ title: `Move ${key} into the vault?`, message: `The key is encrypted for your Windows account and stored as ${name}. Then .mcp.json is changed to read \${${name}} instead, after you review the diff. Circle Studio passes the key to engines it runs in this project; for Claude Code in a terminal, set ${name} in your environment.`, confirmLabel: 'Move it' }))) return;
    try {
      const r = await api.vaultImport({ projectId, server: s.name, field, key, name });
      toast(`${name} is in the vault.`, { kind: 'ok' });
      await reviewChanges({ projectId, ops: [r.op], title: `.mcp.json: read ${key} from the vault`, applyLabel: 'Change .mcp.json' });
    } catch (e) { toast(e.message, { kind: 'danger' }); }
    load();
  }

  function findingsCard() {
    const f = data.findings;
    const fixFor = (x) => {
      if (x.fix === 'vault' && projectId) return h('button', { class: 'cs-btn cs-btn--small cs-btn--primary', type: 'button', onclick: () => moveToVault(x) }, icon('key', 's'), 'Move to the vault');
      if (x.server && x.where?.includes('~/.claude.json')) return h('details', { class: 'cs-details' }, h('summary', {}, 'How to fix'), h('p', { class: 'cs-small' }, 'This one is in Claude Code\'s own settings file, which Circle Studio does not edit. Put the key in the vault (below), then in a terminal in the project: claude mcp remove <name> -s local, and add it again with -e NAME=${NAME} so it reads the key from the environment.'));
      return null;
    };
    return h('section', { class: 'cs-card cs-stack', 'aria-labelledby': 'cx-sec' },
      h('div', { class: 'cs-row cs-row--between cs-row--wrap' }, h('h2', { class: 'cs-h2', id: 'cx-sec' }, 'Security check'),
        f.length ? h('span', { class: `cs-pill cs-pill--${f.some((x) => x.severity === 'danger') ? 'danger' : 'warn'}` }, plural(f.length, 'thing'), ' to fix') : h('span', { class: 'cs-pill cs-pill--ok' }, icon('check', 's'), 'Nothing found')),
      f.length ? h('ul', { class: 'cs-cx__findings' }, f.map((x) => h('li', { class: `cs-cx__finding cs-cx__finding--${x.severity}` },
        icon(x.severity === 'danger' ? 'danger' : 'warning', 's'),
        h('div', { class: 'cs-grow cs-stack cs-stack--tight' }, h('strong', {}, x.title), h('span', { class: 'cs-soft cs-small' }, x.detail), x.where ? h('span', { class: 'cs-mono cs-small cs-soft' }, x.where) : null, fixFor(x)))))
        : h('p', { class: 'cs-soft' }, projectId ? 'No key in plain text, no risky connector, git and agent settings look fine.' : 'No key in plain text and no risky connector. Pick a project above to also check its git and agent settings.'),
      h('details', { class: 'cs-details' }, h('summary', {}, 'What Circle Studio itself does with GitHub'), h('ul', { class: 'cs-prose cs-small' }, data.github.map((g) => h('li', {}, g)))));
  }

  function serverRow(s) {
    const hl = health.get(s.id);
    const [tone, word] = hl?.status === 'checking' ? ['info', 'Checking'] : HEALTH[hl?.status] || HEALTH.unknown;
    const remote = s.transport !== 'stdio' && !/\/\/(localhost|127\.)/.test(s.url || '');
    return h('li', { class: 'cs-cx__server' },
      h('div', { class: 'cs-cx__main' },
        h('div', { class: 'cs-row cs-row--wrap' }, h('strong', {}, s.name), h('span', { class: 'cs-pill cs-pill--quiet' }, s.transport), h('span', { class: `cs-pill cs-pill--${tone}` }, word),
          s.plainSecrets.length ? h('span', { class: 'cs-pill cs-pill--danger' }, icon('key', 's'), 'key in plain text') : null,
          s.vaultRefs.length ? h('span', { class: 'cs-pill cs-pill--ok' }, icon('lock', 's'), `vault: ${s.vaultRefs.join(', ')}`) : null),
        h('span', { class: 'cs-mono cs-small cs-soft cs-cx__cmd' }, s.transport === 'stdio' ? `${s.command} ${s.argsText || ''}` : s.url),
        h('span', { class: 'cs-small cs-soft' }, `${s.scope === 'project' ? 'This project' : s.scope === 'user' ? 'Every project' : s.scope.startsWith('local') ? `Only in ${s.scope.replace('local: ', '') || 'this project'}` : s.scope} · ${s.file}${s.envNames.length ? ` · variables: ${s.envNames.join(', ')}` : ''}${s.headerNames.length ? ` · headers: ${s.headerNames.join(', ')}` : ''}`),
        hl?.text && hl.status !== 'checking' ? h('span', { class: 'cs-small' }, hl.text) : null,
        repairPanel(s)),
      h('div', { class: 'cs-stack cs-stack--tight cs-cx__actions' },
        h('button', { class: 'cs-btn cs-btn--small', type: 'button', title: remote ? 'Opens a connection to the server (leaves this PC)' : 'Looks for the program on this PC', onclick: () => check(s, remote) }, icon('refresh', 's'), remote ? 'Check (connects)' : 'Check'),
        h('button', { class: 'cs-btn cs-btn--small', type: 'button', title: 'Start it the way an engine would and do the MCP handshake', onclick: () => runTest(s) }, icon('play', 's'), 'Test')));
  }

  /* ---- test, diagnose, fix ---------------------------------------------------------------------------------- */
  const repairs = new Map(); // server id -> { busy, test, fix, fixing }

  async function runTest(s) {
    const remote = s.transport !== 'stdio' && !/\/\/(localhost|127\.)/.test(s.url || '');
    const what = s.transport === 'stdio' ? `starts "${s.command} ${s.argsText || ''}" on this PC for up to 45 seconds, the way ${ENGINE[s.engine] || s.engine} would, and stops it again` : `sends an MCP hello to ${s.url}${remote ? ' (this leaves your PC)' : ''}`;
    if (!(await confirmDialog({ title: `Test ${s.name}?`, message: `This ${what}. Keys it needs come from its config and your vault; none are shown.`, confirmLabel: 'Test it' }))) return;
    repairs.set(s.id, { busy: true });
    draw();
    try { repairs.set(s.id, { test: await api.testConnection({ id: s.id, projectId: projectId || undefined }) }); } catch (e) { repairs.set(s.id, { error: e.message }); }
    draw();
  }

  async function askFix(s) {
    const r = repairs.get(s.id) || {};
    repairs.set(s.id, { ...r, fixing: true });
    draw();
    try { repairs.set(s.id, { ...r, fixing: false, fix: await api.fixConnection({ id: s.id, projectId: projectId || undefined }) }); } catch (e) { repairs.set(s.id, { ...r, fixing: false, fixError: e.message }); }
    draw();
  }

  const copyRow = (cmd) => h('div', { class: 'cs-cx__cmdrow' }, h('code', { class: 'cs-mono cs-small' }, cmd), h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small cs-btn--icon', type: 'button', 'aria-label': `Copy ${cmd}`, title: 'Copy', onclick: async () => { try { await navigator.clipboard.writeText(cmd); toast('Copied.', { kind: 'ok', ms: 1500 }); } catch { toast('Could not copy.', { kind: 'warn' }); } } }, icon('copy', 's')));

  function repairPanel(s) {
    const r = repairs.get(s.id);
    if (!r) return null;
    if (r.busy) return h('div', { class: 'cs-loading' }, icon('spinner', 's'), 'Starting it and saying hello...');
    if (r.error) return h('div', { class: 'cs-banner cs-banner--danger' }, icon('danger', 's'), h('span', {}, r.error));
    const t = r.test;
    const parts = [];
    if (t.result.ok) {
      parts.push(h('div', { class: 'cs-banner cs-banner--ok' }, icon('check', 's'), h('span', {}, `Works: ${t.result.serverInfo?.name || s.name} answered in ${(t.result.ms / 1000).toFixed(1)} s with ${plural(t.result.tools.length, 'tool')}${t.result.tools.length ? `: ${t.result.tools.slice(0, 12).join(', ')}` : ''}.`)));
    } else {
      parts.push(h('div', { class: 'cs-banner cs-banner--danger' }, icon('danger', 's'), h('span', {}, `Broken: it failed while ${t.result.stage === 'start' ? 'starting' : t.result.stage === 'tools' ? 'listing its tools' : t.result.stage === 'connect' ? 'connecting' : 'saying hello'}.`)));
      for (const d of t.diagnosis) {
        parts.push(h('div', { class: 'cs-cx__cause' }, h('strong', {}, d.cause), h('span', {}, d.fix),
          ...(d.cmds || []).map(copyRow),
          d.vault ? h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => { const box = list.querySelector('.cs-cx__add input'); if (box) { box.value = d.vault; box.scrollIntoView({ block: 'center' }); box.nextElementSibling?.focus(); } } }, icon('key', 's'), `Add ${d.vault} to the vault`) : null));
      }
      if (!t.diagnosis.length) parts.push(h('p', { class: 'cs-small' }, 'No known cause matched. Its output is below; Claude can read it with the code around it.'));
    }
    if (t.output) parts.push(h('details', { class: 'cs-details' }, h('summary', {}, 'Its output'), h('pre', { class: 'cs-cx__out' }, t.output)));
    if (!t.result.ok) {
      if (r.fixing) parts.push(h('div', { class: 'cs-loading' }, icon('spinner', 's'), 'Claude is reading the error and the code...'));
      else if (r.fix) parts.push(fixView(s, r.fix));
      else parts.push(h('div', { class: 'cs-row cs-row--wrap' }, h('button', { class: 'cs-btn cs-btn--small cs-btn--primary', type: 'button', onclick: () => askFix(s) }, icon('sparkle', 's'), 'Ask Claude to fix it'), r.fixError ? h('span', { class: 'cs-small cs-soft' }, r.fixError) : null));
    }
    parts.push(h('div', {}, h('button', { class: 'cs-btn cs-btn--small cs-btn--quiet', type: 'button', onclick: () => runTest(s) }, icon('refresh', 's'), 'Test again')));
    return h('div', { class: 'cs-cx__repair' }, ...parts);
  }

  function fixView(s, f) {
    return h('div', { class: 'cs-cx__fix' },
      h('div', { class: 'cs-eyebrow' }, `Claude's fix${f.models?.length ? ` (${f.models.join(', ')})` : ''}`),
      f.summary ? h('p', {}, f.summary) : null,
      f.steps.length ? h('ol', { class: 'cs-prose cs-small' }, f.steps.map((x) => h('li', {}, x))) : null,
      ...f.commands.map(copyRow),
      f.config ? h('div', { class: 'cs-stack cs-stack--tight' }, h('strong', { class: 'cs-small' }, 'A corrected config'), h('code', { class: 'cs-mono cs-small' }, `${f.config.command || s.command} ${(f.config.args || []).join(' ')}`),
        f.op ? h('div', {}, h('button', { class: 'cs-btn cs-btn--small cs-btn--primary', type: 'button', onclick: async () => {
          const done = await reviewChanges({ projectId, ops: [f.op], title: `.mcp.json: fix ${s.name}`, applyLabel: 'Change .mcp.json' });
          if (done) { toast('Changed. Testing it again...', { kind: 'ok' }); await load(); const again = data.servers.find((x) => x.name === s.name && x.scope === 'project'); if (again) runTest(again); }
        } }, icon('diff', 's'), 'Apply the config fix')) : h('span', { class: 'cs-soft cs-small' }, `This server lives in ${s.file}, which Circle Studio does not edit: change it there (or remove and add it again with the command above).`)) : null,
      f.codebase.length ? h('div', { class: 'cs-stack cs-stack--tight' }, h('strong', { class: 'cs-small' }, 'For its code'), h('ul', { class: 'cs-prose cs-small' }, f.codebase.map((c) => h('li', {}, c.file ? h('span', { class: 'cs-mono' }, `${c.file}: `) : null, c.advice)))) : null);
  }

  function serversCard() {
    const by = new Map();
    for (const s of data.servers) { if (!by.has(s.engine)) by.set(s.engine, []); by.get(s.engine).push(s); }
    return h('section', { class: 'cs-card cs-stack', 'aria-labelledby': 'cx-srv' },
      h('div', { class: 'cs-row cs-row--between cs-row--wrap' }, h('h2', { class: 'cs-h2', id: 'cx-srv' }, 'Connected'), h('span', { class: 'cs-soft cs-small' }, `${plural(data.servers.length, 'server')} across ${plural(by.size, 'engine')}`)),
      data.servers.length ? [...by].map(([engine, servers]) => h('div', { class: 'cs-stack cs-stack--tight' }, h('div', { class: 'cs-eyebrow' }, ENGINE[engine] || engine), h('ul', { class: 'cs-cx__servers' }, servers.map(serverRow))))
        : h('p', { class: 'cs-soft' }, 'No MCP servers are set up for any engine here. Add them with each tool (for example claude mcp add) and they show up here.'));
  }

  function vaultCard() {
    const name = h('input', { class: 'cs-input', placeholder: 'NAME, for example STITCH_API_KEY', 'aria-label': 'Key name', autocomplete: 'off', spellcheck: 'false' });
    const value = h('input', { class: 'cs-input', type: 'password', placeholder: 'The key', 'aria-label': 'Key value', autocomplete: 'off' });
    const where = h('select', { class: 'cs-select', 'aria-label': 'Where it may be used' }, h('option', { value: 'all' }, 'Every project'), state.projects.filter((p) => p.exists).map((p) => h('option', { value: p.id, selected: p.id === projectId || undefined }, `Only ${p.name}`)));
    const add = async () => {
      const n = name.value.trim().toUpperCase();
      try {
        await api.vaultSet(n, { value: value.value, projects: where.value === 'all' ? 'all' : [where.value] });
        value.value = '';
        toast(`${n} is in the vault.`, { kind: 'ok' });
        load();
      } catch (e) { toast(e.message, { kind: 'danger' }); }
    };
    const whereText = (k) => (k.projects === 'all' ? 'every project' : k.projects.map((id) => state.projects.find((p) => p.id === id)?.name || id).join(', ') || 'nowhere yet');
    return h('section', { class: 'cs-card cs-stack', 'aria-labelledby': 'cx-vault' },
      h('h2', { class: 'cs-h2', id: 'cx-vault' }, 'Key vault'),
      h('p', { class: 'cs-soft' }, 'Keys for your connectors, kept on this PC and encrypted for your Windows account. A key is never shown again; Circle Studio hands it to an engine it runs in a project you allowed, as an environment variable that .mcp.json can read as ${NAME}. Anthropic keys are refused: Claude runs through your own sign-in.'),
      keys.length ? h('ul', { class: 'cs-cx__keys' }, keys.map((k) => h('li', { class: 'cs-cx__key' }, icon('lock', 's'), h('div', { class: 'cs-grow' }, h('strong', { class: 'cs-mono' }, k.name), h('div', { class: 'cs-soft cs-small' }, `For ${whereText(k)} · changed ${timeAgo(k.updatedAt)}${k.note ? ` · ${k.note}` : ''}`)),
        h('button', { class: 'cs-btn cs-btn--small cs-btn--quiet', type: 'button', onclick: () => editKey(k) }, 'Where'),
        h('button', { class: 'cs-btn cs-btn--small cs-btn--quiet cs-btn--danger', type: 'button', 'aria-label': `Delete ${k.name}`, onclick: async () => { if (await confirmDialog({ title: `Delete ${k.name}?`, message: 'Engines will no longer get it. Connectors that read it will stop working until you add it again.', confirmLabel: 'Delete', danger: true })) { await api.vaultRemove(k.name); load(); } } }, icon('trash', 's')))))
        : h('p', { class: 'cs-soft cs-small' }, 'No keys yet.'),
      h('div', { class: 'cs-cx__add' }, name, value, where, h('button', { class: 'cs-btn cs-btn--primary', type: 'button', onclick: add }, icon('plus', 's'), 'Add key')));
  }

  function editKey(k) {
    const boxes = state.projects.filter((p) => p.exists).map((p) => h('label', { class: 'cs-check' }, h('input', { type: 'checkbox', value: p.id, checked: (k.projects === 'all' || k.projects.includes(p.id)) || undefined }), h('span', {}, p.name)));
    const all = h('label', { class: 'cs-check' }, h('input', { type: 'checkbox', checked: k.projects === 'all' || undefined }), h('span', {}, h('strong', {}, 'Every project')));
    openModal({ title: `Where ${k.name} may be used`, body: h('div', { class: 'cs-stack cs-stack--tight' }, all, ...boxes), actions: [{ label: 'Cancel', kind: 'quiet' }, { label: 'Save', kind: 'primary', onClick: async (c) => {
      const projects = all.querySelector('input').checked ? 'all' : boxes.filter((b) => b.querySelector('input').checked).map((b) => b.querySelector('input').value);
      try { await api.vaultSet(k.name, { projects }); c.close(null); load(); } catch (e) { toast(e.message, { kind: 'danger' }); }
    } }] });
  }

  function draw() {
    if (!data) return;
    list.replaceChildren(findingsCard(), serversCard(), vaultCard());
  }

  el.append(h('div', { class: 'cs-stack cs-stack--loose cs-cx' },
    h('header', { class: 'cs-row cs-row--between cs-row--wrap' }, h('div', {}, h('h1', { class: 'cs-h1', id: 'main-title' }, 'Connections'), h('p', { class: 'cs-soft' }, 'What your engines are connected to, whether it works, and whether any key is exposed.')), picker),
    list));
  await load();
  return {};
}
