// How a person gets each engine going: what it is, what account it needs, and the exact install and sign-in commands
// (the sign-in commands were read from each CLI's own --help on this PC). "Do it for me" opens a visible PowerShell
// window running one of these fixed commands: the person sees it and answers it there (a sign-in opens their browser).
// Nothing typed by the person is ever run, and no key is ever asked for: every engine signs in with its own account.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { badRequest } from '../errors.mjs';

export const SETUP = {
  claude: {
    label: 'Claude Code', maker: 'Anthropic',
    account: 'A Claude account (Pro or Max plan) or an Anthropic Console account.',
    does: 'Runs agents and chats, the workflow helper, Find skills, the Advisor and Haiku readers.',
    install: 'npm install -g @anthropic-ai/claude-code',
    login: 'claude auth login',
    link: 'https://docs.anthropic.com/en/docs/claude-code/setup',
  },
  codex: {
    label: 'Codex', maker: 'OpenAI',
    account: 'A ChatGPT account (Plus, Pro or Team) or an OpenAI account.',
    does: 'Runs agents and chats on OpenAI models, and checks other agents\' work.',
    install: 'npm install -g @openai/codex',
    login: 'codex login',
    link: 'https://github.com/openai/codex',
  },
  gemini: {
    label: 'Gemini (Antigravity)', maker: 'Google',
    account: 'A Google account.',
    does: 'Answers questions and checks work on Gemini models (it cannot ask you for approvals, so it does not edit files).',
    install: null, // installed with Google's Antigravity, not through npm
    login: 'agy',
    link: 'https://antigravity.google',
  },
  copilot: {
    label: 'GitHub Copilot', maker: 'GitHub',
    account: 'A GitHub account with a Copilot plan.',
    does: 'Runs agents and chats on the models your Copilot plan includes.',
    install: 'npm install -g @github/copilot',
    login: 'copilot login',
    link: 'https://docs.github.com/en/copilot',
  },
  // not an engine: GitHub itself, through its CLI (private repositories, Actions and pull requests, more searches)
  github: {
    label: 'GitHub', maker: 'GitHub',
    account: 'A GitHub account.',
    does: 'Optional: private repositories, Actions and pull requests on project pages, and more GitHub searches when finding skills. Circle Studio never sees your token.',
    install: 'winget install --id GitHub.cli -e --source winget',
    login: 'gh auth login --hostname github.com --web --git-protocol https',
    link: 'https://cli.github.com',
  },
};

/** Open a PowerShell window that runs one fixed setup command and stays open, so the person sees what happened. */
export function openSetupTerminal(engine, step, { spawnImpl = spawn } = {}) {
  const s = SETUP[engine];
  if (!s) throw badRequest('Unknown engine.');
  const cmd = step === 'install' ? s.install : step === 'login' ? s.login : null;
  if (!cmd) throw badRequest(step === 'install' ? `${s.label} is not installed with a command: get it from ${s.link}.` : 'Say install or login.');
  if (process.platform !== 'win32') throw badRequest(`Open a terminal and run: ${cmd}`);
  const title = `${s.label}: ${step === 'install' ? 'installing' : 'signing in'}`;
  const script = [
    `$Host.UI.RawUI.WindowTitle = '${title.replace(/'/g, "''")}'`,
    `Write-Host 'Circle Studio runs: ${cmd}' -ForegroundColor Cyan`,
    cmd,
    "Write-Host ''",
    "Write-Host 'Done. Go back to Circle Studio and press Check again. You can close this window.' -ForegroundColor Green",
  ].join('; ');
  // through wscript and a small launcher (a PowerShell started detached from Node closes at once); the command goes
  // as -EncodedCommand (UTF-16LE base64), which the launcher checks is nothing but base64
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawnImpl(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'), [LAUNCHER, encoded], { detached: true, stdio: 'ignore', windowsHide: false });
  child.on?.('error', () => {});
  child.unref?.();
  return { opened: true, command: cmd };
}

const LAUNCHER = path.resolve(import.meta.dirname, '..', '..', '..', 'scripts', 'open-terminal.vbs');
