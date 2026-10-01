// Engine-lane services: the engine registry, the Inbox and the session broker. Returned keys are spread onto `app`.
import { ClaudeService } from './lib/claude.mjs';
import { Engines, defaultAdapters } from './lib/engines/index.mjs';
import { Inbox } from './lib/inbox.mjs';
import { Sessions } from './lib/sessions.mjs';

export function createEngineServices({ config, store, projects, chats, overrides = {}, app }) {
  const claude = overrides.claude || new ClaudeService({ bin: config.claudeBin });
  const engines = new Engines(overrides.adapters || defaultAdapters({ claudeService: claude }));
  const inbox = new Inbox({ store });
  const sessions = new Sessions({
    projects, chats, inbox, engines, config,
    getNode: (projectId, nodeId) => app.workflows.head(projects.get(projectId)).nodes.find((n) => n.id === nodeId) || null,
    getBrief: (projectId) => app.plans.get(projects.get(projectId)).brief.what,
  });
  return { claude, engines, inbox, sessions };
}
