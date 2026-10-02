// Test helpers: a temp copy of the reference scaffold (never written back) and a tiny synthetic team.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REFERENCE = process.env.CIRCLE_TEST_PROJECT || path.join(os.homedir(), 'Desktop', 'circle-studio');
export const hasReference = fs.existsSync(path.join(REFERENCE, 'models.json'));

export function tempDir(prefix = 'circle-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Copy the reference project (without .git) into a temp folder and return its path. */
export function copyReference() {
  const dest = tempDir('circle-proj-');
  fs.cpSync(REFERENCE, dest, {
    recursive: true,
    filter: (src) => !/[\\/]\.git([\\/]|$)/.test(src) && !/__pycache__/.test(src),
  });
  return dest;
}

export function rmDir(dir) {
  // a process a test started there (a probed MCP server) may still be closing on Windows: retry for a few seconds
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

const MODELS = `{
  "_comment": "test fixture",
  "_allowed": ["opus", "sonnet", "haiku"],

  "roles": {
    "planner": {
      "model": "sonnet",
      "note": "Plans."
    },

    "researcher": {
      "model": "haiku",
      "note": "Researches."
    }
  }
}
`;

/** A small synthetic team project. Returns its path. */
export function makeMiniProject({ crlfRoster = true } = {}) {
  const dir = tempDir('circle-mini-');
  const w = (rel, text) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  w('models.json', MODELS);
  w('.claude/agents/planner.md', '---\nname: planner\ndescription: Plans things.\nmodel: sonnet\ntools: Read, Grep\n---\n\nBody.\n');
  w('.claude/agents/researcher.md', '---\nname: researcher\ndescription: Researches things.\nmodel: haiku\ntools: Read, Grep\n---\n\nBody.\n');
  w('.claude/consult.config.json', `${JSON.stringify({
    default: 'gemini',
    failover: ['gemini', 'copilot', 'codex', 'self'],
    cooldownMinutes: { quota: 60, rate_limit: 10 },
    engines: { gemini: { model: '', effort: 'high' }, codex: { model: '' }, copilot: { model: '' } },
    roles: { _comment: 'roles', researcher: { engine: 'gemini', web: true, failover: ['copilot', 'codex', 'self'] } },
  }, null, 2)}\n`);
  const roster = JSON.stringify({ _comment: 'optional agents', optional: { researcher: true, deployer: false } }, null, 2);
  w('.claude/state/roster.json', crlfRoster ? roster.replace(/\n/g, '\r\n') : roster);
  w('.claude/state/freeze.json', '{\n  "frozen": [],\n  "request_id": null,\n  "paths": []\n}\n');
  w('REFERENCE-LINKS.md', '# Reference links\n\n## All agents\n\n## planner\n\n## researcher\n');
  w('docs/tasks/BOARD.md', '# Board\n\n| TX | Owner | Status | Source | Summary | Updated |\n|---|---|---|---|---|---|\n| TX-001 | planner | open | human | First thing | 2026-01-01 |\n');
  w('docs/adr/001-stack.md', '# ADR 001 - Stack\n\n- **Status:** proposed\n- **Date:** 2026-01-01\n\n## Context\n\nStatus of things.\n');
  w('docs/adr/002-db.md', '# ADR 002 - DB\r\n\r\n- **Status:** accepted\r\n- **Date:** 2026-01-02\r\n\r\n## Context\r\n');
  w('.mcp.json', '{\n  "mcpServers": {\n    "demo": { "type": "http", "url": "https://example.test/mcp", "headers": { "Authorization": "Bearer ${DEMO_TOKEN:-sk-ant-abcdefghijklmnop1234}" } }\n  }\n}\n');
  w('.gitignore', 'node_modules/\n.env\n');
  w('CLAUDE.md', '# Project directives\n');
  return dir;
}
