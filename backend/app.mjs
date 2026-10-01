// Wires the services together. Tests build this with a temp data folder.
import { Store } from './lib/store.mjs';
import { Projects } from './lib/projects.mjs';
import { Library } from './lib/skills.mjs';
import { Plans, Chats } from './lib/records.mjs';
import { createEngineServices } from './services.engines.mjs';
import { createWorkflowServices } from './services.workflow.mjs';
import { createDesktopServices } from './services.desktop.mjs';
import { Vault } from './lib/vault.mjs';
import { Catalog } from './lib/catalog.mjs';
import { createGithub } from './lib/github.mjs';
import { ChangeManager } from './lib/changes.mjs';
import { pickFolder } from './lib/pickfolder.mjs';
import { codeFingerprint } from './lib/codeversion.mjs';

export function createApp(config, overrides = {}) {
  const store = new Store(config.dataDir);
  const projects = new Projects({ store, config });
  const library = new Library({ store });
  const plans = new Plans(store);
  const chats = new Chats(store);
  const github = createGithub({
    fetchImpl: overrides.fetch || globalThis.fetch,
    token: config.githubToken,
    libraryDirLength: library.dir.length,
    exists: (key) => library.has(key),
  });
  const app = { config, store, overrides, projects, library, plans, chats, github, fetchImpl: overrides.fetch || globalThis.fetch, pickFolder: overrides.pickFolder || pickFolder, codeAtStart: codeFingerprint(config.appRoot) };
  Object.assign(app, createWorkflowServices({ config, store }), createEngineServices({ config, store, projects, chats, overrides, app }));
  Object.assign(app, createDesktopServices({ config, store, projects, sessions: app.sessions, overrides }));
  app.vault = new Vault(store, overrides.vaultCodec);
  app.catalog = new Catalog(store);
  app.sessions.vaultEnv = (projectId) => app.vault.envFor(projectId);
  const changes = new ChangeManager({
    store,
    resolveProject: (id, opts) => projects.resolve(id, opts),
    ctx: {
      libraryFiles: (name) => library.files(name),
      skillEngines: (name) => library.enginesFor(name),
      resolveRoot: (from) => projects.resolveRoot(from),
      getPlan: (id) => plans.get(projects.get(id)),
      getWorkflow: (id) => app.workflows.head(projects.get(id)),
    },
    onEffect: (e) => { if (e.kind === 'skill-use') library.use(e.name); },
  });
  app.changes = changes;
  return app;
}
