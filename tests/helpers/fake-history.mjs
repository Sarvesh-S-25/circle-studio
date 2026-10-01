// Writes Claude Code transcripts the way the CLI keeps them (~/.claude/projects/<key>/<session>.jsonl, with subagent
// runs under <session>/subagents/), so tests never read the human's real ~/.claude folder.
import fs from 'node:fs';
import path from 'node:path';
import { folderKey } from '../../backend/lib/cchistory.mjs';

const line = (o) => `${JSON.stringify(o)}\n`;

export function writeConversation(home, root, { id, title, turns, agents = [], at = '2026-09-20T10:00:00.000Z' }) {
  const dir = path.join(home, 'projects', folderKey(root));
  fs.mkdirSync(dir, { recursive: true });
  let out = line({ type: 'permission-mode', permissionMode: 'default', sessionId: id });
  let n = 0;
  for (const [you, claude, tool] of turns) {
    n++;
    out += line({ type: 'user', isSidechain: false, message: { role: 'user', content: you }, uuid: `u${n}`, timestamp: at, cwd: root, sessionId: id });
    if (tool) {
      out += line({ type: 'assistant', isSidechain: false, message: { id: `m${n}`, model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'tool_use', id: `t${n}`, name: 'Read', input: { file_path: path.join(root, tool) } }] }, timestamp: at });
      out += line({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: 'file text' }] }, timestamp: at, cwd: root });
    }
    // one answer, written over two lines that repeat the same usage (as Claude Code does)
    const usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_1h_input_tokens: 200 }, output_tokens: 50 };
    out += line({ type: 'assistant', isSidechain: false, message: { id: `m${n}b`, model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'thinking', thinking: '' }], usage }, timestamp: at });
    out += line({ type: 'assistant', isSidechain: false, message: { id: `m${n}b`, model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'text', text: claude }], usage }, timestamp: at });
  }
  out += line({ type: 'assistant', message: { id: 'syn', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] } });
  if (title) out += line({ type: 'ai-title', aiTitle: title, sessionId: id });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), out);
  for (const a of agents) {
    const sub = path.join(dir, id, 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, `${a.run}.meta.json`), JSON.stringify({ agentType: a.agentType, description: a.description }));
    fs.writeFileSync(path.join(sub, `${a.run}.jsonl`), line({ type: 'user', isSidechain: true, message: { role: 'user', content: a.prompt } }) + line({ type: 'assistant', isSidechain: true, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: a.answer }] } }));
  }
  return path.join(dir, `${id}.jsonl`);
}
