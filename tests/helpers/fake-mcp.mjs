// A stand-in MCP server over stdio for the connection tests. node fake-mcp.mjs <mode>
//   ok       answers initialize and tools/list (two tools); echoes whether FAKE_MCP_KEY reached it
//   crash    prints a Python-style missing-module error and exits 1
//   silent   starts and never answers
const mode = process.argv[2] || 'ok';
//   needkey  like ok, but fails unless FAKE_MCP_KEY holds a real value (not empty, not an unexpanded ${...})
if (mode === 'needkey' && (!process.env.FAKE_MCP_KEY || process.env.FAKE_MCP_KEY.startsWith('$'))) {
  process.stderr.write(`401 Unauthorized: FAKE_MCP_KEY is ${process.env.FAKE_MCP_KEY ? 'not expanded' : 'missing'}\n`);
  process.exit(1);
}
if (mode === 'crash') {
  process.stderr.write("Traceback (most recent call last):\nModuleNotFoundError: No module named 'fastapi'\n");
  process.exit(1);
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  if (mode === 'silent') return;
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const send = (x) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: o.id, ...x })}\n`);
    if (o.method === 'initialize') send({ result: { protocolVersion: o.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: process.env.FAKE_MCP_KEY ? 'with-key' : 'no-key' } } });
    else if (o.method === 'tools/list') send({ result: { tools: [{ name: 'search', inputSchema: { type: 'object' } }, { name: 'open_app', inputSchema: { type: 'object' } }] } });
  }
});
setTimeout(() => process.exit(0), 60_000).unref();
