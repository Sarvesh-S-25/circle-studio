// A JSON-RPC peer over a child's stdio, one message per line. Used by Copilot (ACP) and Codex (app-server).
import { lineReader, parseLine } from './proc.mjs';
import { redact } from '../secrets.mjs';

export class RpcPeer {
  /**
   * @param child a spawned process with piped stdio
   * @param opts.jsonrpc  add "jsonrpc":"2.0" to outgoing messages (ACP does, Codex app-server does not)
   * @param opts.onRequest async (method, params) => result, for requests the other side sends; throw to answer with an error
   * @param opts.onNotification (method, params) => void
   */
  constructor(child, { jsonrpc = true, onRequest, onNotification, onClose, timeoutMs = 30_000 } = {}) {
    this.child = child;
    this.jsonrpc = jsonrpc;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    this.onClose = onClose;
    this.timeoutMs = timeoutMs;
    this.diagnostic = '';
    this.next = 1;
    this.pending = new Map();
    this.closed = false;
    child.stdin.on('error', () => {});
    this.flush = lineReader(child.stdout, (line) => this.#incoming(line));
    child.stderr?.on('data', (data) => { this.diagnostic = redact((this.diagnostic + data.toString('utf8')).slice(-8192)); });
    child.on('close', (code) => { this.flush(); this.#close(new Error(`The engine process ended${code == null ? '' : ` (exit ${code})`}.`)); });
    child.on('error', (e) => this.#close(e));
  }

  #send(msg) {
    if (this.closed || this.child.stdin.destroyed || this.child.stdin.writableEnded) return false;
    this.child.stdin.write(`${JSON.stringify(this.jsonrpc ? { jsonrpc: '2.0', ...msg } : msg)}\n`);
    return true;
  }

  request(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('The engine process ended.')); return; }
      const id = this.next++;
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The engine did not answer ${method} within ${Math.round(timeoutMs / 1000)} seconds.`));
      }, timeoutMs) : null;
      timer?.unref?.();
      this.pending.set(id, { resolve, reject, method, timer });
      if (!this.#send({ id, method, params })) { clearTimeout(timer); this.pending.delete(id); reject(new Error('The engine process ended.')); }
    });
  }

  notify(method, params = {}) { this.#send({ method, params }); }

  #close(err) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
    this.onClose?.(err);
  }

  close() { this.#close(new Error('Closed.')); try { this.child.stdin.end(); } catch { /* gone */ } }

  async #incoming(line) {
    const m = parseLine(line);
    if (!m) return;
    if (m.method !== undefined && m.id !== undefined) {
      try {
        const result = await this.onRequest?.(m.method, m.params ?? {}, m.id);
        this.#send({ id: m.id, result: result ?? {} });
      } catch (e) {
        this.#send({ id: m.id, error: { code: -32603, message: String(e?.message || e).slice(0, 300) } });
      }
    } else if (m.method !== undefined) {
      try { this.onNotification?.(m.method, m.params ?? {}); } catch { /* a bad handler must not kill the stream */ }
    } else if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(Object.assign(new Error(String(m.error.message || 'The engine refused the request.').slice(0, 300)), { rpc: m.error }));
      else p.resolve(m.result ?? {});
    }
  }
}
