// Build a ChangeManager over a temp data dir and one project, the way the server wires it.
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../backend/lib/store.mjs';
import { ChangeManager } from '../../backend/lib/changes.mjs';
import { Library } from '../../backend/lib/skills.mjs';
import { defaultPlan } from '../../backend/lib/plan.mjs';
import { normalizeWorkflow } from '../../backend/lib/workflow.mjs';
import { tempDir } from './project.mjs';

export const SEED_FILE = path.resolve(import.meta.dirname, '..', '..', 'backend', 'seed', 'staged-build-team.json');
export const seedWorkflow = () => normalizeWorkflow(JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')));

/** `others` = { id: root } of more projects an op may copy from; `workflow` and `plan` replace the defaults. */
export function makeEngine(projectRoot, { plan, workflow, others = {} } = {}) {
  const dataDir = tempDir('circle-data-');
  const store = new Store(dataDir);
  const library = new Library({ store });
  const roots = { p1: projectRoot, ...others };
  const effects = [];
  const cm = new ChangeManager({
    store,
    resolveProject: (id) => ({ id, root: roots[id], name: path.basename(roots[id]) }),
    ctx: {
      libraryFiles: (name) => library.files(name),
      skillEngines: (name) => library.enginesFor(name),
      resolveRoot: (from) => roots[from],
      getPlan: () => plan || defaultPlan('p1', 'demo'),
      getWorkflow: () => workflow || seedWorkflow(),
    },
    onEffect: (e) => { effects.push(e); library.use(e.name); },
  });
  return { cm, store, library, dataDir, effects };
}
