// Templates, project workflows (the graph), their semantic versions, and creating projects from a template.
// Owner: the workflow lane. Handlers for templates.*, workflow.*, projects.create, projects.plan.get and
// projects.plan.save. The shape of every route is in docs/spec.md.
import { badRequest } from './lib/errors.mjs';
import { diffText } from './lib/diff.mjs';
import { redact } from './lib/secrets.mjs';
import { looksBinary } from './lib/textfile.mjs';
import { defaultPlan, normalizePlan, lintPlan } from './lib/plan.mjs';
import { normalizeWorkflow, lintWorkflow } from './lib/workflow.mjs';
import { renderProject } from './lib/render.mjs';
import { HELPER_SCHEMA, helperPrompt, helperResult } from './lib/helper.mjs';
import { newProjectFolder, writeNewProject } from './lib/projects.mjs';
import { str } from './lib/route-helpers.mjs';
import { projectDigest } from './lib/digest.mjs';
import { ensureCatalog } from './routes.catalog.mjs';

const ALL = { write: true, run: true, claude: true };
const opt = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/**
 * The engines that can run now, or undefined when the engine service is not there or cannot say yet. Uses only what
 * is already detected: asking every CLI takes seconds on a cold start and must never hold a page up.
 */
async function usableEngines(app) {
  if (typeof app.engines?.list !== 'function') return undefined;
  if (typeof app.engines.known === 'function') {
    const known = app.engines.known();
    if (!known) { app.engines.list().catch(() => {}); return undefined; } // warm the cache for next time
    return new Set(known.filter((e) => e.usable).map((e) => e.id));
  }
  try {
    const res = await app.engines.list();
    const list = Array.isArray(res) ? res : res?.engines;
    return Array.isArray(list) ? new Set(list.filter((e) => e.usable).map((e) => e.id)) : undefined;
  } catch {
    return undefined;
  }
}

/** A rendered file as the new-project preview shows it, in the shape the diff review already draws. */
function fileView(f) {
  const bytes = Buffer.byteLength(f.content);
  if (typeof f.content !== 'string' && looksBinary(f.content)) return { path: f.path, status: 'added', via: 'app', binary: true, bytes, diff: { added: 0, removed: 0, hunks: [] } };
  const text = redact(typeof f.content === 'string' ? f.content : f.content.toString('utf8'));
  return { path: f.path, status: 'added', via: 'app', eol: 'lf', bytes, diff: diffText('', text) };
}

export function buildWorkflowHandlers(app) {
  const { projects, plans, templates, workflows, changes, library, config } = app;
  const withWarnings = async (view) => ({ ...view, warnings: lintWorkflow(view.workflow, { usable: await usableEngines(app) }) });

  /** The brief's lanes and flags follow the workflow (Workflows.syncFlags does the other direction). */
  function mirrorToPlan(project, workflow) {
    const plan = plans.get(project);
    const same = Object.keys(workflow.lanes).every((k) => plan.lanes[k] === workflow.lanes[k])
      && plan.localOnly === workflow.flags.localOnly && plan.humanDoesGit === workflow.flags.humanDoesGit;
    if (!same) plans.save(project, { ...plan, lanes: { ...workflow.lanes }, localOnly: workflow.flags.localOnly, humanDoesGit: workflow.flags.humanDoesGit });
  }

  /** The workflow a new template starts from: the one sent, another template's, a project's, or none (blank). */
  function templateSource(body) {
    if (['workflow', 'templateId', 'projectId'].filter((k) => body?.[k] !== undefined).length > 1) throw badRequest('Give one of workflow, templateId or projectId.');
    if (body?.workflow !== undefined) return { workflow: body.workflow };
    if (body?.templateId !== undefined) return { workflow: templates.head(str(body.templateId, 'templateId', 60)), copy: true };
    if (body?.projectId !== undefined) return { workflow: workflows.head(projects.get(str(body.projectId, 'projectId', 60))), copy: true };
    return {};
  }

  return {
    'templates.list': () => ({ templates: templates.list() }),
    'templates.create': async ({ body }) => {
      const { workflow, copy } = templateSource(body);
      const name = opt(body?.name, 100) || (copy ? `${workflow.name} copy`.slice(0, 100) : undefined);
      return withWarnings(templates.create({ workflow, name, description: opt(body?.description, 2000) }));
    },
    'templates.import': async ({ body }) => withWarnings(templates.import({ path: body?.path ?? undefined, json: body?.json ?? undefined, name: body?.name })),
    'templates.get': async ({ params }) => withWarnings(templates.get(params.id)),
    'templates.save': async ({ params, body }) => withWarnings(templates.save(params.id, { workflow: body?.workflow, note: body?.note, bump: body?.bump })),
    'templates.remove': ({ params }) => { templates.remove(params.id); return {}; },

    'workflow.get': async ({ params }) => withWarnings(workflows.get(projects.get(params.id))),
    'workflow.save': async ({ params, body }) => {
      const project = projects.get(params.id);
      if (body?.write === true) projects.resolve(params.id, { write: true });
      const result = workflows.save(project, { workflow: body?.workflow, note: body?.note, bump: body?.bump });
      mirrorToPlan(project, result.workflow);
      const out = await withWarnings(result);
      if (body?.write === true) out.preview = changes.preview(project.id, [{ op: 'workflow-write' }]);
      return out;
    },
    'workflow.suggest': async ({ params, body }) => {
      const project = projects.resolve(params.id, { need: 'claude' });
      const message = str(body?.message, 'message', 4000);
      const record = workflows.get(projects.get(params.id));
      const current = body?.workflow !== undefined ? normalizeWorkflow(body.workflow) : record.workflow;
      const history = Array.isArray(body?.history) ? body.history.filter((m) => m && typeof m.text === 'string').slice(-6) : [];
      const engineList = typeof app.engines?.list === 'function' ? await app.engines.list().then((r) => (Array.isArray(r) ? r : r?.engines) || []).catch(() => []) : [];
      const skills = library.list().map((s) => s.name);
      await app.claude.requireReady();
      // what the helper reads besides the graph: the folder itself, the best-fitting building blocks, matching passages of indexed links
      const plan = plans.get(projects.get(params.id));
      const digest = projectDigest(project.root);
      await ensureCatalog(app);
      const query = `${message} ${plan?.brief?.what || ''} ${digest.slice(0, 600)}`;
      const blocks = app.catalog.search(query, { types: ['skill', 'agent', 'connector', 'link'], limit: 12 });
      const urls = current.nodes.flatMap((n) => n.links || []);
      const passages = app.catalog.passages(message, { urls: urls.length ? urls : null, limit: 3 });
      const prompt = helperPrompt({ workflow: current, plan, lanes: current.lanes, engines: engineList, skills, history, message, digest, blocks, passages });
      const model = ['haiku', 'sonnet', 'opus'].includes(body?.model) ? body.model : undefined;
      const r = await app.claude.advise({ key: `helper:${project.id}`, prompt, model, root: project.root, schema: HELPER_SCHEMA, kind: 'helper', projectId: project.id });
      const usable = new Set(engineList.filter((e) => e.usable).map((e) => e.id));
      return { ...helperResult(current, r.data, { skills, usable: engineList.length ? usable : undefined }), models: r.models, costUsd: r.costUsd, ms: r.ms, read: { digest: digest.length > 0, blocks: blocks.map((b) => `${b.type}: ${b.name}`), passages: passages.map((p) => p.title) } };
    },
    'workflow.restore': async ({ params, body }) => {
      const project = projects.get(params.id);
      const result = workflows.restore(project, str(body?.version, 'version', 20), body?.note);
      mirrorToPlan(project, result.workflow);
      return withWarnings(result);
    },

    'projects.create': async ({ body }) => {
      const name = body?.name;
      const target = newProjectFolder(config, name, body?.folder);
      let workflow;
      if (body?.workflow !== undefined) workflow = normalizeWorkflow(body.workflow);
      else if (typeof body?.templateId === 'string') workflow = templates.head(body.templateId);
      else throw badRequest('Pick a template, or send a workflow.');
      workflow = { ...workflow, version: '1.0.0' };
      const idea = opt(body?.idea, 4000) || '';
      const planInput = { idea, brief: { ...defaultPlan('', name).brief, name, what: idea }, lanes: workflow.lanes, localOnly: workflow.flags.localOnly, humanDoesGit: workflow.flags.humanDoesGit };
      const { files, warnings } = renderProject({ name, idea, workflow, plan: normalizePlan(planInput, ''), library: { files: (n) => library.files(n), enginesFor: (n) => library.enginesFor(n) } });
      if (body?.confirm !== true) return { confirmed: false, target, files: files.map(fileView), warnings };
      writeNewProject(target, files);
      const project = await projects.add(target, body.permissions ?? ALL);
      workflows.create(project, { workflow, templateId: opt(body.templateId, 60) });
      plans.save(project, planInput);
      return { confirmed: true, project, files: files.map((f) => f.path), warnings };
    },
    'projects.plan.get': ({ params }) => {
      const project = projects.get(params.id);
      workflows.ensure(project);
      const plan = plans.get(project);
      return { plan, warnings: lintPlan(plan) };
    },
    'projects.plan.save': ({ params, body }) => {
      const project = projects.get(params.id);
      workflows.ensure(project);
      const plan = plans.save(project, body?.plan);
      workflows.syncFlags(project, plan);
      return { plan, warnings: lintPlan(plan) };
    },
  };
}
