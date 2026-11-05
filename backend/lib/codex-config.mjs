// A deliberately narrow writer: only Circle-owned MCP sections, never unrelated TOML or provider credentials.
import { badRequest, conflict } from './errors.mjs';
import { scanSecrets } from './secrets.mjs';

export function codexMcpText(current, name, config) {
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(name || '')) throw badRequest('Use a simple MCP server name.');
  const text = current || '';
  if (/'''|"""|^\s*mcp_servers\s*=|^\s*\[\s*["']mcp_servers["']/m.test(text)) throw badRequest('This config uses TOML forms this narrow editor does not support. It was left unchanged.');
  if (scanSecrets(text).length) throw badRequest('This config may contain credentials. Move them out before editing it here.');
  const begin = `# circle:mcp:${name}:start`; const end = `# circle:mcp:${name}:end`;
  const start = text.indexOf(begin); const finish = text.indexOf(end);
  if ((start < 0) !== (finish < 0) || (start >= 0 && (finish < start || text.indexOf(begin, start + 1) >= 0 || text.indexOf(end, finish + 1) >= 0))) throw conflict('The managed section is ambiguous. Repair it by hand before changing it here.');
  const rest = start >= 0 ? text.slice(0, start) + text.slice(finish + end.length) : text;
  const table = new RegExp(`^\\s*\\[\\[?\\s*mcp_servers\\.(?:${name}|"${name}"|'${name}')(?=[.\\s\\]])`, 'm');
  if (table.test(rest)) throw conflict('An unmanaged table already configures this server. It was left unchanged; review it in your editor.');
  if (config === null) return rest;
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some((k) => !['command', 'args', 'url', 'env_vars'].includes(k))) throw badRequest('Supported fields are command, args, url and env_vars only.');
  if (Boolean(config.command) === Boolean(config.url)) throw badRequest('Give either a command or a URL.');
  if (config.command && (typeof config.command !== 'string' || config.command.length > 500 || /[\r\n\0]/.test(config.command))) throw badRequest('Invalid MCP command.');
  if (config.url) { let url; try { url = new URL(config.url); } catch { throw badRequest('Invalid MCP URL.'); } if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw badRequest('Use an HTTP(S) URL without embedded credentials.'); }
  for (const key of ['args', 'env_vars']) if (config[key] !== undefined && (!Array.isArray(config[key]) || config[key].length > 50 || config[key].some((v) => typeof v !== 'string' || v.length > 1000 || /\0/.test(v) || (key === 'env_vars' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v))))) throw badRequest(`Invalid ${key}.`);
  if (scanSecrets(JSON.stringify(config)).length) throw badRequest('Connector credentials must not be written into this config. Use environment variable names.');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = [begin, `[mcp_servers.${name}]`, ...Object.entries(config).map(([key, value]) => `${key} = ${JSON.stringify(value)}`), end];
  const block = lines.join(eol);
  return start >= 0 ? text.slice(0, start) + block + text.slice(finish + end.length) : `${text}${text && !text.endsWith('\n') ? eol : ''}${block}${eol}`;
}
