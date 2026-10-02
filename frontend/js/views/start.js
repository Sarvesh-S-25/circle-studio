// Let's begin: for someone opening Circle Studio for the first time. Circle Studio does not have its own AI: it runs
// the AI tools you already use (Claude Code, Codex, Gemini through Antigravity, GitHub Copilot) with your own sign-in.
// Pick the ones you use; for each one that is not ready yet, the exact install and sign-in steps, a button that runs
// them in a terminal you can see, and Check again. No API key is ever asked for here.
import { api } from '../api.js';
import { h, icon } from '../dom.js';
import { state, refreshEngines, pref, setPref } from '../state.js';
import { toast } from '../components/overlay.js';

const ORDER = ['claude', 'codex', 'gemini', 'copilot'];

export async function mount(el) {
  const chosen = new Set((() => { try { return JSON.parse(pref('start-engines', '[]')); } catch { return []; } })());
  const body = h('div', { class: 'cs-stack cs-stack--loose' });
  let checking = false;
  let other = pref('start-other', '') === '1';

  const statusOf = (e) => (e.usable ? ['ok', 'Ready'] : e.installed ? ['warn', 'Installed, not signed in'] : ['quiet', 'Not installed']);
  const copyBtn = (cmd) => h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small cs-btn--icon', type: 'button', 'aria-label': `Copy ${cmd}`, title: 'Copy', onclick: async () => { try { await navigator.clipboard.writeText(cmd); toast('Copied. Paste it in a terminal (PowerShell).', { kind: 'ok', ms: 2500 }); } catch { toast('Could not copy.', { kind: 'warn' }); } } }, icon('copy', 's'));
  const doIt = (e, step) => h('button', { class: 'cs-btn cs-btn--small', type: 'button', title: 'Opens a terminal window that runs this command; watch it there', onclick: async () => {
    try { await api.engineTerminal(e.id, step); toast(step === 'login' ? 'A terminal opened: follow it (your browser may open to sign in). Then press Check again.' : 'A terminal opened and is installing. When it says Done, press Check again.', { kind: 'info', ms: 9000 }); } catch (x) { toast(x.message, { kind: 'danger' }); }
  } }, icon('play', 's'), 'Do it for me');

  function steps(e) {
    const s = e.setup;
    if (!s || e.usable) return null;
    const items = [];
    if (!e.installed) {
      items.push(s.install
        ? h('li', {}, h('span', {}, 'Install it:'), h('div', { class: 'cs-start__cmd' }, h('code', { class: 'cs-mono' }, s.install), copyBtn(s.install), doIt(e, 'install')))
        : h('li', {}, h('span', {}, 'Install it from '), h('a', { href: s.link, target: '_blank', rel: 'noopener noreferrer' }, s.link), h('span', {}, ' (it is not installed with a command).')));
    }
    items.push(h('li', {}, h('span', {}, s.install || e.installed ? 'Sign in with your account (a browser opens):' : 'Then sign in:'), h('div', { class: 'cs-start__cmd' }, h('code', { class: 'cs-mono' }, s.login), copyBtn(s.login), e.installed || s.install ? doIt(e, 'login') : null)));
    items.push(h('li', {}, h('span', {}, 'Then press '), h('strong', {}, 'Check again'), h('span', {}, '.')));
    return h('ol', { class: 'cs-start__steps' }, items);
  }

  function card(e) {
    const [tone, word] = statusOf(e);
    const on = chosen.has(e.id);
    const s = e.setup || {};
    return h('section', { class: `cs-card cs-start__card ${on ? 'cs-start__card--on' : ''}`, 'aria-labelledby': `st-${e.id}` },
      h('label', { class: 'cs-row cs-row--wrap cs-start__pick' },
        h('input', { type: 'checkbox', checked: on || undefined, onchange: (ev) => { if (ev.target.checked) chosen.add(e.id); else chosen.delete(e.id); setPref('start-engines', JSON.stringify([...chosen])); draw(); } }),
        h('strong', { id: `st-${e.id}` }, s.label || e.label), h('span', { class: 'cs-soft cs-small' }, s.maker ? `by ${s.maker}` : ''), h('span', { class: 'cs-grow' }),
        h('span', { class: `cs-pill cs-pill--${tone}` }, e.usable ? icon('check', 's') : null, word)),
      h('p', { class: 'cs-small' }, s.does || ''),
      on ? h('p', { class: 'cs-soft cs-small' }, `You need: ${s.account || 'an account for it'}`) : null,
      on ? steps(e) : null);
  }

  // GitHub, optional: through the GitHub CLI, which keeps the sign-in itself (Circle Studio never sees a token)
  function githubSection() {
    const g = state.github;
    if (!g?.setup) return null;
    const pseudo = { id: 'github', installed: g.installed, usable: g.signedIn, setup: g.setup };
    const [tone, word] = g.signedIn ? ['ok', `Signed in${g.account ? ` as ${g.account}` : ''}`] : g.installed ? ['warn', 'Installed, not signed in'] : ['quiet', 'Not installed'];
    return h('section', { class: 'cs-stack cs-stack--tight', 'aria-labelledby': 'st-gh' },
      h('h2', { class: 'cs-h3', id: 'st-gh' }, '2. GitHub (optional)'),
      h('section', { class: 'cs-card cs-start__card' },
        h('div', { class: 'cs-row cs-row--wrap' }, icon('github', 's'), h('strong', {}, 'Sign in to GitHub'), h('span', { class: 'cs-grow' }), h('span', { class: `cs-pill cs-pill--${tone}` }, g.signedIn ? icon('check', 's') : null, word)),
        h('p', { class: 'cs-small' }, g.setup.does),
        g.signedIn ? h('p', { class: 'cs-soft cs-small' }, 'To sign out: gh auth logout in a terminal.') : steps(pseudo)));
  }

  let autoPicked = chosen.size > 0;
  function draw() {
    const engines = ORDER.map((id) => state.engines.find((e) => e.id === id)).filter(Boolean);
    // the first time: tick what is already on this PC
    if (!autoPicked && engines.length) { autoPicked = true; engines.filter((e) => e.installed).forEach((e) => chosen.add(e.id)); }
    const readyChosen = engines.filter((e) => chosen.has(e.id) && e.usable);
    const ready = engines.filter((e) => e.usable);
    body.replaceChildren(
      h('section', { class: 'cs-stack cs-stack--tight', 'aria-labelledby': 'st-which' },
        h('h2', { class: 'cs-h3', id: 'st-which' }, '1. Which AI tools do you use?'),
        h('p', { class: 'cs-soft' }, 'Tick the ones you have, or want. Most people start with one.'),
        engines.length ? h('div', { class: 'cs-start__grid' }, engines.map(card),
          h('section', { class: `cs-card cs-start__card ${other ? 'cs-start__card--on' : ''}` },
            h('label', { class: 'cs-row cs-row--wrap cs-start__pick' }, h('input', { type: 'checkbox', checked: other || undefined, onchange: (ev) => { other = ev.target.checked; setPref('start-other', other ? '1' : ''); draw(); } }), h('strong', {}, 'Something else'), h('span', { class: 'cs-soft cs-small' }, 'OpenClaw, Cursor, Aider...')),
            other ? h('p', { class: 'cs-small' }, 'Circle Studio cannot run these. Here every agent asks you before it runs a command or changes a file; OpenClaw runs a task on its own with no way to ask you first (and usually needs API keys), and Cursor and Aider have no way for Circle Studio to relay your answers. You can still plan workflows, keep keys and skills, and use the widgets here, and run your tool in its own window.') : h('p', { class: 'cs-small cs-soft' }, 'Not supported; see why and what still works.')))
          : h('div', { class: 'cs-loading' }, icon('spinner', 's'), 'Looking for AI tools on this PC...')),
      h('div', { class: 'cs-row cs-row--wrap' },
        h('button', { class: 'cs-btn', type: 'button', disabled: checking || undefined, onclick: check }, icon(checking ? 'spinner' : 'refresh', 's'), checking ? 'Checking...' : 'Check again'),
        h('span', { class: 'cs-soft cs-small' }, ready.length ? `Ready now: ${ready.map((e) => e.setup?.label || e.label).join(', ')}.` : 'Nothing is ready yet.')),
      githubSection(),
      h('section', { class: 'cs-stack cs-stack--tight', 'aria-labelledby': 'st-go' },
        h('h2', { class: 'cs-h3', id: 'st-go' }, '3. Start'),
        ready.length
          ? h('p', {}, readyChosen.length || !chosen.size ? 'You are set. Pick a project folder on Home, or describe something new to build.' : 'Something is ready, but not what you ticked yet: finish its steps above, or start with what is ready.')
          : h('p', { class: 'cs-soft' }, 'Once one tool says Ready, you can start. You can also look around first: nothing runs without one.'),
        !ready.some((e) => e.id === 'claude') && ready.length ? h('p', { class: 'cs-soft cs-small' }, 'Without Claude Code, the workflow helper and Find skills are off; agents and chats run on the tools that are ready.') : null,
        h('div', { class: 'cs-row cs-row--wrap' },
          h('button', { class: `cs-btn ${ready.length ? 'cs-btn--primary' : ''}`, type: 'button', onclick: () => { setPref('started', '1'); location.hash = '#/'; } }, ready.length ? 'Go to Home' : 'Look around first'))),
      h('details', { class: 'cs-details cs-small' }, h('summary', {}, 'Good to know'),
        h('ul', { class: 'cs-prose' },
          h('li', {}, 'No API key is needed: each tool uses your own account, and Circle Studio never sees your password.'),
          h('li', {}, 'Commands run in PowerShell. They need Node.js, which you already have (Circle Studio runs on it).'),
          h('li', {}, 'Everything stays on this PC. Come back here any time from Settings, or Ctrl+K "Let\'s begin".'))));
  }

  async function check() {
    checking = true;
    draw();
    try { await refreshEngines(true); } catch (e) { toast(e.message, { kind: 'danger' }); }
    checking = false;
    draw();
  }

  el.append(h('div', { class: 'cs-stack cs-stack--loose cs-page' },
    h('header', { class: 'cs-stack cs-stack--tight' }, h('h1', { class: 'cs-h1', id: 'main-title' }, "Let's begin"),
      h('p', { class: 'cs-soft' }, 'Circle Studio has no AI of its own. It runs the AI tools you already use, with your own sign-in, and lets you plan, watch and approve what their agents do.')),
    body));
  const onEngines = () => draw();
  window.addEventListener('circle:engines', onEngines);
  draw();
  if (!state.engines.length || !state.engines[0].setup) await check();
  // while this page is open, notice a tool that was just installed or signed in
  const timer = setInterval(() => { if (document.visibilityState === 'visible' && !checking && state.engines.some((e) => chosen.has(e.id) && !e.usable)) refreshEngines(true).catch(() => {}); }, 30_000);
  return { destroy: () => { clearInterval(timer); window.removeEventListener('circle:engines', onEngines); } };
}
