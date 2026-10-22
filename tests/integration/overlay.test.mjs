// The overlay (Ctrl+Alt+C, like the Xbox Game Bar): reading typed commands (lib/overlay.mjs) and running them
// (routes.overlay.mjs) against the real server with the fake Claude. A sent message runs on its own and its answer is
// read back from overlay.feed; what the agent wants to run still waits for you, and `allow 1` lets it go on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, rmDir } from '../helpers/project.mjs';
import { parseCommand, findByName, splitAgent, splitNumber, pcStats, workflowMap, gitPanel, helpLines, projectChoices, withoutLive } from '../../backend/lib/overlay.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmd = (s, text, projectId) => s.call('POST', '/api/overlay/command', { text, projectId });

test('parseCommand: known words, sentences go to the chat, one unknown word is a typo', () => {
  assert.deepEqual(parseCommand('help'), { id: 'help', rest: '' });
  assert.deepEqual(parseCommand('  Allow   2 '), { id: 'allow', rest: '2' });
  assert.deepEqual(parseCommand('/open inbox'), { id: 'open', rest: 'inbox' });
  assert.deepEqual(parseCommand('@planner write it'), { id: 'run', rest: 'planner write it' });
  assert.deepEqual(parseCommand('what changed today'), { id: 'ask', rest: 'what changed today' });
  assert.deepEqual(parseCommand('why?'), { id: 'ask', rest: 'why?' });
  assert.deepEqual(parseCommand('hlep'), { id: 'unknown', rest: 'hlep' });
  assert.deepEqual(parseCommand(''), { id: 'empty', rest: '' });
  assert.ok(helpLines().some((l) => l.startsWith('allow')));
});

test('names, agents and numbers are found the way people type them', () => {
  const list = [{ id: 'shop-app', name: 'Shop App' }, { id: 'shop-site', name: 'Shop site' }, { id: 'notes', name: 'Notes' }];
  assert.equal(findByName(list, 'notes').id, 'notes');
  assert.equal(findByName(list, 'shopa').id, 'shop-app');
  assert.equal(findByName(list, 'shop').ambiguous.length, 2);
  assert.equal(findByName(list, 'zzz'), null);
  const agents = [{ id: 'planner', title: 'Planner' }, { id: 'code-reviewer', title: 'Code reviewer' }];
  assert.deepEqual(splitAgent('code reviewer: look at it', agents), { agent: agents[1], message: 'look at it' });
  assert.deepEqual(splitAgent('planner', agents), { agent: agents[0], message: '' });
  assert.equal(splitAgent('nobody do it', agents).agent, null);
  assert.deepEqual(splitNumber('2 yes please'), { n: 2, text: 'yes please' });
  assert.deepEqual(splitNumber('yes'), { n: 1, text: 'yes' });
});

test('the small panels: PC numbers, the workflow drawn small, git in words', () => {
  const pc = pcStats();
  assert.ok(pc.cpu === null || (pc.cpu >= 0 && pc.cpu <= 100));
  assert.ok(pc.memPct > 0 && pc.memPct <= 100 && pc.memTotalGb > 0 && pc.cores > 0);
  const m = workflowMap({ stages: [{ title: 'Plan', state: 'done', who: [{ title: 'Planner', state: 'done' }] }, { title: 'Build', state: 'working', who: [] }, { title: 'Ship', state: 'idle', who: [], checkpoint: 'you' }] });
  assert.deepEqual([m.done, m.total, m.now, m.stages[2].checkpoint, m.stages[0].agents[0].title], [1, 3, 'Build: working', true, 'Planner']);
  assert.equal(workflowMap(null), null);
  assert.equal(gitPanel({ isRepo: true, branch: 'main', changed: 2, ahead: 1 }).line, '2 files changed · 1 to push');
  assert.equal(gitPanel({ isRepo: false }).isRepo, false);
});

test('the project switcher: each project says whether it needs you, works or is quiet', () => {
  const list = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
  const out = projectChoices(list, [{ projectId: 'b' }, { projectId: 'c' }], [{ projectId: 'c' }, { projectId: 'c' }], 'b');
  assert.deepEqual(out.map((p) => [p.id, p.state, p.word, p.current]), [
    ['a', 'idle', 'Quiet', false], ['b', 'working', 'Working', true], ['c', 'waiting', '2 things wait for you', false],
  ]);
  assert.equal(projectChoices(list.slice(0, 1), [], [{ projectId: 'a' }]).at(0).word, '1 thing waits for you');
});

test('overlay: feed, help, project switch, open, typos, then ask -> the agent asks -> allow 1 -> the answer comes in', async () => {
  const s = await startServer();
  const root = makeMiniProject();
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: { write: true, run: true, claude: true } })).json.project.id;
    const feed = (await s.call('GET', `/api/overlay?projectId=${id}&theme=light`)).json;
    assert.equal(feed.ok, true);
    assert.equal(feed.project.id, id);
    assert.ok(feed.palette.raised && feed.pc.memTotalGb > 0);
    assert.deepEqual(feed.waiting, []);
    assert.ok(Array.isArray(feed.running) && Array.isArray(feed.examples));
    // widgets added from the Widgets menu come drawn for the project shown; unknown kinds are left out
    assert.deepEqual(feed.extras, []);
    assert.ok(feed.extrasOffered.some((x) => x.kind === 'pulse'));
    const ex = (await s.call('GET', `/api/overlay?projectId=${id}&extra=status,pulse,nope`)).json.extras;
    assert.deepEqual(ex.map((t) => t.kind), ['status', 'pulse']);
    assert.equal(ex[0].projectId, id);
    // the desktop tiles' project picker gets each project's state too
    assert.equal((await s.call('GET', '/api/widgets/feed')).json.projects.find((p) => p.id === id).state, 'idle');

    assert.equal((await cmd(s, 'help', id)).json.say.title, 'What you can type');
    assert.equal((await cmd(s, 'hlep', id)).json.say.tone, 'warn');
    const sw = (await cmd(s, `project ${feed.project.name}`, id)).json;
    assert.equal(sw.projectId, id);
    const op = (await cmd(s, 'open inbox', id)).json;
    assert.deepEqual([op.open, op.hide], ['#/inbox', true]);
    assert.equal((await cmd(s, 'open workflow', id)).json.open, `#/projects/${id}/workflow`);
    assert.equal((await cmd(s, 'chat', id)).json.chatWindow, id);
    assert.equal((await cmd(s, 'hide', id)).json.hide, true);
    assert.equal((await cmd(s, 'allow', id)).json.say.title, 'Nothing waits for you.');
    assert.match((await cmd(s, 'pc', id)).json.say.title, /^Processor/);
    assert.ok((await cmd(s, 'git', id)).json.say.lines.some((l) => /read only/.test(l)));
    assert.equal((await s.call('POST', '/api/overlay/command', { projectId: id })).status, 400);

    // a sentence goes to the main chat and runs on its own; the fake agent asks to run a command first
    process.env.FAKE_CLAUDE = 'bash';
    const sent = (await cmd(s, 'please check the build', id)).json;
    assert.equal(sent.command, 'ask');
    assert.match(sent.say.title, /Sent to/);
    let w = [];
    for (let i = 0; i < 100 && !w.length; i++) { await sleep(50); w = (await s.call('GET', `/api/overlay?projectId=${id}`)).json.waiting; }
    assert.equal(w.length, 1);
    const mine = (await s.call('GET', `/api/overlay?projectId=${id}`)).json.projects.find((p) => p.id === id);
    assert.deepEqual([mine.state, mine.waiting, mine.current], ['waiting', 1, true]);
    assert.deepEqual([w[0].n, w[0].kind, w[0].detail], [1, 'approval', 'echo circle-live']);
    assert.match((await cmd(s, 'waiting', id)).json.say.lines[0], /^1\. /);
    assert.equal((await cmd(s, 'answer 1 yes', id)).json.say.tone, 'warn'); // an approval is not a question
    assert.equal((await cmd(s, 'allow 1', id)).json.say.title, 'Allowed.');
    let live = null;
    for (let i = 0; i < 100; i++) { await sleep(50); live = (await s.call('GET', `/api/overlay?projectId=${id}`)).json.live; if (live?.done) break; }
    assert.equal(live.done, true);
    assert.equal(live.you, 'please check the build');
    assert.equal(live.error, null);
    assert.ok(live.text.length > 0);
    assert.equal((await cmd(s, 'stop', id)).json.say.title, 'Nothing was running here.');
  } finally {
    delete process.env.FAKE_CLAUDE;
    await s.close();
    rmDir(root);
  }
});

test('the bar shows a message being answered once: the copy Claude Code already wrote is left out until it is done', () => {
  const talk = { title: 't', messages: [{ who: 'You', mine: true, text: 'first' }, { who: 'Claude', mine: false, text: 'ok' }, { who: 'You', mine: true, text: 'what is the plan?' }, { who: 'Claude', mine: false, text: 'The plan is' }] };
  assert.deepEqual(withoutLive(talk, { you: 'what is the plan?', done: false }).messages.map((m) => m.text), ['first', 'ok']);
  assert.equal(withoutLive(talk, { you: 'what is the plan?', done: true }), talk, 'done: the list has it all, nothing live');
  assert.equal(withoutLive(talk, { you: 'not written yet', done: false }), talk, 'not in the list yet: nothing left out');
  assert.equal(withoutLive(talk, null), talk);
});
