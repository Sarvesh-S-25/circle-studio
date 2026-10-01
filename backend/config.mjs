// Runtime configuration. Everything comes from environment variables with local defaults.
import os from 'node:os';
import path from 'node:path';

export const APP_ROOT = path.resolve(import.meta.dirname, '..');

export function loadConfig(env = process.env) {
  return {
    host: '127.0.0.1',
    port: Number(env.CIRCLE_PORT) || 4380,
    appRoot: APP_ROOT,
    frontendDir: path.join(APP_ROOT, 'frontend'),
    dataDir: path.resolve(env.CIRCLE_DATA || path.join(APP_ROOT, 'data')),
    projectsRoot: path.resolve(env.CIRCLE_PROJECTS_ROOT || path.join(os.homedir(), 'Desktop')),
    claudeBin: env.CIRCLE_CLAUDE_BIN || 'claude',
    // Where Claude Code keeps its own transcripts (read only, to show the conversations the human had outside the app).
    userHome: path.resolve(env.CIRCLE_USER_HOME || os.homedir()), // where ~/.claude.json, ~/.gemini and ~/.copilot live
    codexHome: path.resolve(env.CIRCLE_CODEX_HOME || env.CODEX_HOME || path.join(os.homedir(), '.codex')),
    claudeHome: path.resolve(env.CIRCLE_CLAUDE_HOME || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')),
    githubToken: env.GITHUB_TOKEN || '',
  };
}
