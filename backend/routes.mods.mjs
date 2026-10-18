// Claude Code mods and plugins: what is installed, sorted into "for every project" and "only this project".
// Handlers for mods.*. Reading is local files only. The project setting changes through changes.preview/apply
// (op mod-set); the general one through the claude CLI itself (`claude plugin enable|disable --scope user`), the same
// command a person would type, so ~/.claude/settings.json keeps the shape Claude Code writes.
import { badRequest } from './lib/errors.mjs';
import { projectMods, allMods, CATEGORIES, PLUGIN_ID_RE, findPluginRoot } from './lib/mods.mjs';
import { listStarters, hasTests, readValidate, readTests } from './lib/modstarters.mjs';
import { runCommand, cleanEnv } from './lib/run.mjs';
import { redact } from './lib/secrets.mjs';

export function buildModHandlers(app) {
  const { projects, config } = app;
  const runClaude = (args, timeoutMs = 60_000) => (app.overrides?.runClaude || ((a) => runCommand(app.claude.bin, [...(app.claude.prefix || []), ...a], { cwd: config.userHome, timeoutMs, env: cleanEnv() })))(args, config.userHome);
  const pluginOf = (v) => {
    if (typeof v !== 'string' || !PLUGIN_ID_RE.test(v)) throw badRequest('Say which mod: its name@source, as Claude Code lists it.');
    return v;
  };
  const say = (r) => redact(`${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`.trim()).slice(0, 4000);

  return {
    // ?projectId= gives that project's view (general / this project only / off here); without it, the whole PC.
    'mods.list': ({ query }) => {
      const projectId = query.get('projectId') || null;
      if (projectId) {
        const { root } = projects.resolve(projectId);
        return { scope: 'project', categories: CATEGORIES, mods: projectMods({ claudeHome: config.claudeHome, root }) };
      }
      return { scope: 'all', categories: CATEGORIES, mods: allMods({ claudeHome: config.claudeHome, projects: projects.list() }) };
    },
    // On or off for every project. Runs `claude plugin enable|disable <id> --scope user`.
    'mods.general': async ({ body }) => {
      const id = pluginOf(body?.plugin);
      if (typeof body?.on !== 'boolean') throw badRequest('on must be true or false.');
      const args = ['plugin', body.on ? 'enable' : 'disable', id, '--scope', 'user'];
      const r = await runClaude(args);
      const output = say(r);
      // the CLI exits 1 with "is already enabled at user scope" when there is nothing to do: that is what was asked
      return { ok: r.code === 0 || /already (enabled|disabled)/i.test(output), command: `claude ${args.join(' ')}`, output };
    },
    // The ready-made mods Circle Studio ships (added to a project with the mod-add op, a diff you review).
    'mods.starters': () => ({ starters: listStarters() }),
    // Check a mod the way Claude Code will load it: `claude plugin validate <folder>`, then `claude plugin test <folder>`
    // when it has tests. Nothing is installed, changed or switched on.
    'mods.check': async ({ body }) => {
      const id = pluginOf(body?.plugin);
      const root = findPluginRoot(id, { claudeHome: config.claudeHome, projects: projects.list() });
      if (!root) throw badRequest('That mod is not installed on this PC.');
      const v = await runClaude(['plugin', 'validate', root]);
      const both = (r) => [r.stdout, r.stderr].filter(Boolean).join('\n');
      const validate = { ...readValidate(both(v), v.code), command: 'claude plugin validate <its folder>' };
      let tests = null;
      if (hasTests(root)) {
        const t = await runClaude(['plugin', 'test', root], 180_000);
        tests = { ...readTests(both(t), t.code), command: 'claude plugin test <its folder>' };
      }
      const output = say({ stdout: [v.stdout, v.stderr].filter(Boolean).join('\n') });
      return { ok: validate.ok && (!tests || tests.ok), validate, tests, output };
    },
    // What it brings and what it costs in context, from `claude plugin details <id>`.
    'mods.details': async ({ body }) => {
      const id = pluginOf(body?.plugin);
      const args = ['plugin', 'details', id];
      const r = await runClaude(args);
      return { ok: r.code === 0, command: `claude ${args.join(' ')}`, output: say(r) };
    },
  };
}
