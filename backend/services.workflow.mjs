// Workflow-lane services: templates and each project's workflow. Returned keys are spread onto `app`.
import path from 'node:path';
import { Templates, Workflows } from './lib/templates.mjs';

export function createWorkflowServices({ config, store }) {
  const templates = new Templates({ store, seedFile: path.join(config.appRoot, 'backend', 'seed', 'staged-build-team.json') });
  const workflows = new Workflows({ store, templates });
  return { templates, workflows };
}
