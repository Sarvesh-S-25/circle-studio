// Connections: the tools (MCP servers) agents can use. As a project's tab: what this project gets (its own, every
// project's, and what plugins bring), whether each works and has its key, one-click ways to give a key, add a tool or
// remove one, with a check that nothing is added twice. On the Keys page (`pc`): every connection on this PC, the
// manager and the security check. Everything is read on this PC; a remote server is only contacted on Check or Test.
import { api } from '../api.js';
import { h, icon, plural } from '../dom.js';
import { reviewChanges } from '../components/diffreview.js';
import { confirmDialog, toast } from '../components/overlay.js';
import { managerCard, keyForm, runAction } from '../components/cxmanager.js';

const ENGINE = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', copilot: 'Copilot', vscode: 'VS Code' };
const HEALTH = { ok: ['ok', 'Works'], broken: ['danger', 'Broken'], unknown: ['info', 'Not checked'], off: ['quiet', 'Off'] };
const suggestName = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'K_$1').slice(0, 60) || 'API_KEY';
const isBundled = (s) => /^(plugin|extension): /.test(s.scope);
const origin = (s) => (s.scope === 'project' ? 'In this project\'s files (shared)' : s.scope === 'local' ? 'Only this project (just you)' : s.scope === 'user' ? 'Every project (yours)' : isBundled(s) ? `Comes with the ${s.scope.replace(': ', ' ')}` : s.scope.startsWith('local: ') ? `Only in ${s.scope.slice(7)}` : s.scope);
// "npx -y @x/mcp@latest" and "npx @x/mcp" are the same server
const setupKey = (s) => (s.transport === 'stdio' ? `${s.command} ${s.argsText || ''}`.replace(/\s-y\b|\s--yes\b/g, '').replace(/@(latest|\^?[\d.]+)(?=\s|$)/g, '') : s.url || '').trim().toLowerCase();

export async function mount(el, ctx) {
  const projectId = ctx.project?.id || ctx.params?.projectId || '';
  const pc = !projectId;
  let data = null;
  let keys = [];
  const health = new Map();
  const manager = pc ? managerCard({ onChanged: () => load() }) : null;
  const list = h('div', { class: 'cs-stack cs-stack--loose' });

  async function load() {
    list.replaceChildren(h('div', { class: 'cs-loading' }, icon('spinner', 'm'), 'Reading the connector files...'));
    try {
      [data, keys] = await Promise.all([api.connections(projectId), api.vault().then((v) => v.keys).catch(() => [])]);
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
    if (!(await confirmDialog({ title: `Move ${key} into your saved keys?`, message: `The key is encrypted for your Windows account and saved as ${name}. Then .mcp.json is changed to read \${${name}} instead, after you review the change.`, confirmLabel: 'Move it' }))) return;
    try {
      const r = await api.vaultImport({ projectId, server: s.name, field, key, name });
      toast(`${name} is saved.`, { kind: 'ok' });
      await reviewChanges({ projectId, ops: [r.op], title: `.mcp.json: read ${key} from your saved keys`, applyLabel: 'Change .mcp.json' });
    } catch (e) { toast(e.message, { kind: 'danger' }); }
    load();
  }

  function findingsCard() {
    const f = data.findings;
    const fixFor = (x) => (x.fix === 'vault' && projectId ? h('button', { class: 'cs-btn cs-btn--small cs-btn--primary', type: 'button', onclick: () => moveToVault(x) }, icon('key', 's'), 'Move to my saved keys') : null);
    const body = f.length ? h('ul', { class: 'cs-cx__findings' }, f.map((x) => h('li', { class: `cs-cx__finding cs-cx__finding--${x.severity}` },
      icon(x.severity === 'danger' ? 'danger' : 'warning', 's'),
      h('div', { class: 'cs-grow cs-stack cs-stack--tight' }, h('strong', {}, x.title), h('span', { class: 'cs-soft cs-small' }, x.detail), x.where ? h('span', { class: 'cs-mono cs-small cs-soft' }, x.where) : null, fixFor(x)))))
      : h('p', { class: 'cs-soft' }, projectId ? 'No key in plain text, no risky connector, git and agent settings look fine.' : 'No key in plain text and no risky connector.');
    const pill = f.length ? h('span', { class: `cs-pill cs-pill--${f.some((x) => x.severity === 'danger') ? 'danger' : 'warn'}` }, plural(f.length, 'thing'), ' to fix') : h('span', { class: 'cs-pill cs-pill--ok' }, icon('check', 's'), 'Nothing found');
    return h('details', { class: 'cs-card cs-details cs-cx__sec', open: f.some((x) => x.severity === 'danger') || undefined },
      h('summary', { class: 'cs-row cs-row--between cs-row--wrap' }, h('span', { class: 'cs-h3' }, 'Security check'), pill),
      body,
      h('details', { class: 'cs-details' }, h('summary', {}, 'What Circle Studio itself does with GitHub'), h('ul', { class: 'cs-prose cs-small' }, data.github.map((g) => h('li', {}, g)))));
  }

  /** The other servers that give the same engine the same tool (same name or same command): a duplicate. */
  const twinsOf = (s) => data.servers.filter((x) => x !== s && x.engine === s.engine && !x.disabled && (x.name.toLowerCase() === s.name.toLowerCase() || setupKey(x) === setupKey(s)));

  async function removeHere(s) {
    if (s.scope === 'project') {
      const done = await reviewChanges({ projectId, ops: [{ op: 'mcp-server-remove', server: s.name }], title: `.mcp.json: remove ${s.name}`, applyLabel: 'Remove it' });
      if (done) load();
      return;
    }
    if (await runAction({ kind: 'remove', ids: [s.id] }, { projectId: projectId || null, title: s.scope === 'user' ? `Remove "${s.name}" from every project` : `Remove "${s.name}" from this project` })) load();
  }

  function serverRow(s) {
    const hl = health.get(s.id);
    const [tone, word] = hl?.status === 'checking' ? ['info', 'Checking'] : HEALTH[hl?.status] || HEALTH.unknown;
    const remote = s.transport !== 'stdio' && !/\/\/(localhost|127\.)/.test(s.url || '');
    const twins = projectId ? twinsOf(s) : [];
    const keyless = s.envNames.concat(s.headerNames).filter((n) => /key|token|secret|auth/i.test(n));
    const canRemove = !isBundled(s) && (s.engine === 'claude' && (s.scope === 'local' || s.scope === 'user' || s.scope === 'project'));
    return h('li', { class: 'cs-cx__server' },
      h('div', { class: 'cs-cx__main' },
        h('div', { class: 'cs-row cs-row--wrap' }, h('strong', {}, s.name), h('span', { class: `cs-pill cs-pill--${tone}` }, word),
          s.plainSecrets.length ? h('span', { class: 'cs-pill cs-pill--danger' }, icon('key', 's'), 'key in plain text') : null,
          s.vaultRefs.length ? h('span', { class: 'cs-pill cs-pill--ok' }, icon('lock', 's'), `key: ${s.vaultRefs.join(', ')}`) : null,
          twins.length ? h('span', { class: 'cs-pill cs-pill--warn', title: twins.map((t) => origin(t)).join(', ') }, 'set up twice') : null),
        h('span', { class: 'cs-small' }, origin(s), pc ? ` · ${s.file}` : ''),
        h('span', { class: 'cs-mono cs-small cs-soft cs-cx__cmd' }, s.transport === 'stdio' ? `${s.command} ${s.argsText || ''}` : s.url),
        twins.length ? h('span', { class: 'cs-small cs-soft' }, `Also ${twins.map((t) => origin(t).toLowerCase()).join(' and ')}: one copy is enough.${canRemove && twins.some(isBundled) ? ' The plugin keeps it working if you remove this one.' : ''}`) : null,
        hl?.text && hl.status !== 'checking' ? h('span', { class: 'cs-small' }, hl.text) : null,
        repairPanel(s)),
      h('div', { class: 'cs-stack cs-stack--tight cs-cx__actions' },
        h('button', { class: 'cs-btn cs-btn--small', type: 'button', title: 'Start it the way an engine would and check it answers', onclick: () => runTest(s) }, icon('play', 's'), 'Test'),
        !projectId ? h('button', { class: 'cs-btn cs-btn--small cs-btn--quiet', type: 'button', title: remote ? 'Opens a connection to the server (leaves this PC)' : 'Looks for the program on this PC', onclick: () => check(s, remote) }, icon('refresh', 's'), remote ? 'Check (connects)' : 'Check') : null,
        projectId && s.engine === 'claude' && !isBundled(s) && (keyless.length || s.plainSecrets.length) && !repairs.has(s.id) ? h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => { repairs.set(s.id, { keyOnly: true }); draw(); } }, icon('key', 's'), 'Key') : null,
        projectId && canRemove ? h('button', { class: 'cs-btn cs-btn--small cs-btn--quiet', type: 'button', onclick: () => removeHere(s) }, icon('trash', 's'), s.scope === 'user' ? 'Remove everywhere' : 'Remove') : null));
  }

  /* ---- test, diagnose, fix ---------------------------------------------------------------------------------- */
  const repairs = new Map(); // server id -> { busy, test, fix, fixing, keyOnly }

  async function runTest(s) {
    const remote = s.transport !== 'stdio' && !/\/\/(localhost|127\.)/.test(s.url || '');
    const what = s.transport === 'stdio' ? `starts "${s.command} ${s.argsText || ''}" on this PC for up to 45 seconds, the way ${ENGINE[s.engine] || s.engine} would, and stops it again` : `sends an MCP hello to ${s.url}${remote ? ' (this leaves your PC)' : ''}`;
    if (!(await confirmDialog({ title: `Test ${s.name}?`, message: `This ${what}. Keys it needs come from its config and your saved keys; none are shown.`, confirmLabel: 'Test it' }))) return;
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
  const savedNames = () => keys.map((k) => k.name);

  function repairPanel(s) {
    const r = repairs.get(s.id);
    if (!r) return null;
    if (r.keyOnly) return h('div', { class: 'cs-cx__repair' }, keyForm(s, { projectId: projectId || null, saved: savedNames(), onDone: () => { repairs.delete(s.id); load(); } }),
      h('div', {}, h('button', { class: 'cs-btn cs-btn--small cs-btn--quiet', type: 'button', onclick: () => { repairs.delete(s.id); draw(); } }, 'Close')));
    if (r.busy) return h('div', { class: 'cs-loading' }, icon('spinner', 's'), 'Starting it and saying hello...');
    if (r.error) return h('div', { class: 'cs-banner cs-banner--danger' }, icon('danger', 's'), h('span', {}, r.error));
    const t = r.test;
    const parts = [];
    if (t.result.ok) {
      parts.push(h('div', { class: 'cs-banner cs-banner--ok' }, icon('check', 's'), h('span', {}, `Works: ${t.result.serverInfo?.name || s.name} answered in ${(t.result.ms / 1000).toFixed(1)} s with ${plural(t.result.tools.length, 'tool')}${t.result.tools.length ? `: ${t.result.tools.slice(0, 12).join(', ')}` : ''}.`)));
    } else {
      parts.push(h('div', { class: 'cs-banner cs-banner--danger' }, icon('danger', 's'), h('span', {}, `Broken: it failed while ${t.result.stage === 'start' ? 'starting' : t.result.stage === 'tools' ? 'listing its tools' : t.result.stage === 'connect' ? 'connecting' : 'saying hello'}.`)));
      for (const d of t.diagnosis) parts.push(h('div', { class: 'cs-cx__cause' }, h('strong', {}, d.cause), h('span', {}, d.fix), ...(d.cmds || []).map(copyRow)));
      if (!t.diagnosis.length) parts.push(h('p', { class: 'cs-small' }, 'No known cause matched. Its output is below; Claude can read it with the code around it.'));
    }
    if (t.output) parts.push(h('details', { class: 'cs-details' }, h('summary', {}, 'Its output'), h('pre', { class: 'cs-cx__out' }, t.output)));
    if (!t.result.ok && !isBundled(s)) {
      // the one-click ways out: repeat a working twin, or give it its key
      const twin = t.twins?.[0];
      if (twin && s.engine === 'claude' && s.scope !== 'project') parts.push(h('div', { class: 'cs-row cs-row--wrap' }, h('button', { class: 'cs-btn cs-btn--primary cs-btn--small', type: 'button', onclick: async () => { if (await runAction({ kind: 'repair', id: s.id, from: twin.id }, { projectId: projectId || null })) { repairs.delete(s.id); load(); } } }, icon('sparkle', 's'), `Fix it for me (use the setup from ${twin.where.replace(/^in /, '')})`)));
      const keyTrouble = t.diagnosis.some((d) => d.vault || /key|refused|not set|unauthori/i.test(d.cause));
      if ((keyTrouble || s.envNames.length || s.headerNames.length) && s.engine === 'claude') parts.push(keyForm(s, { projectId: projectId || null, saved: savedNames(), onDone: () => { repairs.delete(s.id); load(); } }));
      if (r.fixing) parts.push(h('div', { class: 'cs-loading' }, icon('spinner', 's'), 'Claude is reading the error and the code...'));
      else if (r.fix) parts.push(fixView(s, r.fix));
      else parts.push(h('div', { class: 'cs-row cs-row--wrap' }, h('button', { class: 'cs-btn cs-btn--small cs-btn--primary', type: 'button', onclick: () => askFix(s) }, icon('sparkle', 's'), 'Ask Claude to fix it'), r.fixError ? h('span', { class: 'cs-small cs-soft' }, r.fixError) : null));
    } else if (!t.result.ok) parts.push(h('p', { class: 'cs-small' }, 'It comes with a plugin: update or reinstall the plugin in Claude Code (type /plugin there).'));
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
        } }, icon('diff', 's'), 'Apply the config fix')) : h('span', { class: 'cs-soft cs-small' }, `This server lives in ${s.file}, which Circle Studio does not edit by hand: change it there (or remove and add it again with the command above).`)) : null,
      f.codebase.length ? h('div', { class: 'cs-stack cs-stack--tight' }, h('strong', { class: 'cs-small' }, 'For its code'), h('ul', { class: 'cs-prose cs-small' }, f.codebase.map((c) => h('li', {}, c.file ? h('span', { class: 'cs-mono' }, `${c.file}: `) : null, c.advice)))) : null);
  }

  /* ---- add a tool to this project (Claude Code), refusing what the project already gets -------------------- */
  let adding = false;
  function addCard() {
    if (!adding) return h('div', {}, h('button', { class: 'cs-btn cs-btn--primary', type: 'button', onclick: () => { adding = true; draw(); list.querySelector('#cx-add-name')?.focus(); } }, icon('plus', 's'), 'Add a tool'));
    const name = h('input', { class: 'cs-input', id: 'cx-add-name', placeholder: 'A short name, for example stitch', autocomplete: 'off', spellcheck: 'false' });
    const how = h('select', { class: 'cs-select', 'aria-label': 'How it runs', onchange: () => sync() }, h('option', { value: 'cmd' }, 'It runs on this PC (a command)'), h('option', { value: 'url' }, 'It is on the web (an address)'));
    const cmd = h('input', { class: 'cs-input cs-mono', placeholder: 'npx -y @some/mcp-server', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'The command that starts it' });
    const url = h('input', { class: 'cs-input cs-mono', placeholder: 'https://example.com/mcp', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Its web address' });
    const keySel = h('select', { class: 'cs-select', 'aria-label': 'Its key', onchange: () => sync() }, h('option', { value: '' }, 'It needs no key'), keys.map((k) => h('option', { value: k.name }, `Saved key ${k.name}`)), h('option', { value: '__paste' }, 'Paste a new key'));
    const keyName = h('input', { class: 'cs-input cs-mono', placeholder: 'STITCH_API_KEY', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'A name for the key' });
    const keyValue = h('input', { class: 'cs-input', type: 'password', placeholder: 'Paste the key', autocomplete: 'off', 'aria-label': 'The key' });
    const slot = h('input', { class: 'cs-input cs-mono', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Where the tool reads the key' });
    const scope = h('select', { class: 'cs-select', 'aria-label': 'Who gets it' }, h('option', { value: 'local' }, 'Only me, in this project (recommended)'), h('option', { value: 'project' }, 'Everyone who uses this folder (.mcp.json)'));
    const dupe = h('div', { 'aria-live': 'polite' });
    const go = h('button', { class: 'cs-btn cs-btn--primary', type: 'button' }, icon('plus', 's'), 'Add it');
    const field = (label, ...els) => h('label', { class: 'cs-field' }, h('span', { class: 'cs-field__label' }, label), ...els);
    const cmdField = field('The command that starts it', cmd);
    const urlField = field('Its web address', url);
    const pasteField = h('div', { class: 'cs-row cs-row--wrap' }, field('Name the key', keyName), field('The key', keyValue));
    const slotField = field('Where the tool reads it (from its instructions)', slot);
    function setup() { return how.value === 'url' ? { url: url.value.trim() } : { command: cmd.value.trim().split(/\s+/)[0] || '', args: cmd.value.trim().split(/\s+/).slice(1) }; }
    function sync() {
      cmdField.hidden = how.value === 'url';
      urlField.hidden = how.value !== 'url';
      pasteField.hidden = keySel.value !== '__paste';
      slotField.hidden = !keySel.value;
      if (!slot.value || slot.dataset.auto === '1') { slot.value = how.value === 'url' ? 'Authorization' : (keySel.value && keySel.value !== '__paste' ? keySel.value : keyName.value.trim().toUpperCase() || 'API_KEY'); slot.dataset.auto = '1'; }
      // does this project already get it? (the same name or the same command, from anywhere)
      const st = setup();
      const probe = { engine: 'claude', transport: st.url ? 'http' : 'stdio', command: st.command || '', argsText: (st.args || []).join(' '), url: st.url ? (() => { try { const u = new URL(st.url); return `${u.protocol}//${u.host}`; } catch { return st.url; } })() : null };
      const n = name.value.trim().toLowerCase();
      const found = data.servers.filter((s) => s.engine === 'claude' && ((n && s.name.toLowerCase() === n) || ((st.command || st.url) && setupKey(s) === setupKey(probe))));
      dupe.replaceChildren(found.length ? h('div', { class: 'cs-banner cs-banner--warn' }, icon('warning', 's'), h('span', {}, `This project already has it: ${found.map((s) => `"${s.name}" (${origin(s).toLowerCase()})`).join(', ')}. No need to add it again.`)) : '');
      go.replaceChildren(icon('plus', 's'), found.length ? 'Add it anyway' : 'Add it');
      go.classList.toggle('cs-btn--primary', !found.length);
      go.dataset.force = found.length ? '1' : '';
    }
    slot.addEventListener('input', () => { slot.dataset.auto = '0'; });
    for (const x of [name, cmd, url, keyName]) x.addEventListener('input', sync);
    go.addEventListener('click', async () => {
      const key = !keySel.value ? null : keySel.value === '__paste' ? { name: keyName.value.trim().toUpperCase(), value: keyValue.value, slot: slot.value.trim(), field: how.value === 'url' ? 'headers' : 'env' } : { name: keySel.value, slot: slot.value.trim(), field: how.value === 'url' ? 'headers' : 'env' };
      const ok = await runAction({ kind: 'add', name: name.value.trim(), setup: setup(), scope: scope.value, key, force: go.dataset.force === '1' }, { projectId });
      keyValue.value = '';
      if (ok) { adding = false; load(); }
    });
    const box = h('section', { class: 'cs-card cs-stack', 'aria-labelledby': 'cx-add' },
      h('h3', { class: 'cs-h3', id: 'cx-add' }, 'Add a tool for Claude Code'),
      h('p', { class: 'cs-soft cs-small' }, 'Copy the details from the tool\'s instructions (its "MCP" setup). Before anything changes you see the steps; afterwards it is started once to check it works.'),
      h('div', { class: 'cs-row cs-row--wrap' }, field('Name', name), field('How it runs', how)),
      cmdField, urlField,
      h('div', { class: 'cs-row cs-row--wrap' }, field('Its key', keySel), field('Who gets it', scope)),
      pasteField, slotField, dupe,
      h('div', { class: 'cs-row' }, go, h('button', { class: 'cs-btn cs-btn--quiet', type: 'button', onclick: () => { adding = false; draw(); } }, 'Cancel')));
    sync();
    return box;
  }

  function serversCard() {
    if (!projectId) {
      const by = new Map();
      for (const s of data.servers) { if (!by.has(s.engine)) by.set(s.engine, []); by.get(s.engine).push(s); }
      return h('section', { class: 'cs-card cs-stack', 'aria-labelledby': 'cx-srv' },
        h('div', { class: 'cs-row cs-row--between cs-row--wrap' }, h('h2', { class: 'cs-h2', id: 'cx-srv' }, 'Every connection on this PC'), h('span', { class: 'cs-soft cs-small' }, `${plural(data.servers.length, 'server')} across ${plural(by.size, 'engine')}`)),
        data.servers.length ? [...by].map(([engine, servers]) => h('div', { class: 'cs-stack cs-stack--tight' }, h('div', { class: 'cs-eyebrow' }, ENGINE[engine] || engine), h('ul', { class: 'cs-cx__servers' }, servers.map(serverRow))))
          : h('p', { class: 'cs-soft' }, 'No connections are set up for any engine yet.'));
    }
    // a project: grouped by engine, plain words, duplicates marked
    const by = new Map();
    for (const s of data.servers) { if (!by.has(s.engine)) by.set(s.engine, []); by.get(s.engine).push(s); }
    const dupes = data.servers.filter((s) => twinsOf(s).length).length;
    return h('section', { class: 'cs-stack', 'aria-label': 'Tools this project can use' },
      dupes ? h('div', { class: 'cs-banner cs-banner--warn' }, icon('warning', 's'), h('span', {}, 'Some tools are set up twice. One copy is enough: remove the one you do not need (a plugin\'s copy keeps working).')) : null,
      data.servers.length ? [...by].map(([engine, servers]) => h('section', { class: 'cs-card cs-stack' }, h('h3', { class: 'cs-h3' }, ENGINE[engine] || engine), h('ul', { class: 'cs-cx__servers' }, servers.map(serverRow))))
        : h('div', { class: 'cs-empty' }, icon('link', 'l'), h('div', { class: 'cs-empty__title' }, 'No tools yet'), h('p', {}, 'This project\'s agents have no extra tools. Add one when a task needs it, for example a design tool or a database.')));
  }

  function draw() {
    if (!data) return;
    if (pc) list.replaceChildren(manager.el, findingsCard(), serversCard());
    else list.replaceChildren(addCard(), serversCard(), findingsCard());
  }

  el.append(h('div', { class: 'cs-stack cs-stack--loose cs-cx' },
    pc ? null : h('div', { class: 'cs-stack cs-stack--tight' },
      h('p', { class: 'cs-soft' }, 'Tools this project\'s agents can use (MCP servers), such as a design tool, a database or a browser. Keys come from your ', h('a', { href: '#/keys' }, 'saved keys'), '. Before you add one, Circle Studio checks the project does not already have it (from every project\'s settings or a plugin).')),
    list));
  await load();
  return {};
}
