// The only file that calls fetch. Every path is a literal from contracts/api.json.

export class ApiError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { ...(method !== 'GET' ? { 'X-Circle': '1' } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'offline', 'Circle Studio\'s server is not reachable. Is `node backend/server.mjs` still running?');
  }
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!json || json.ok !== true) {
    const e = json && json.error;
    throw new ApiError(res.status, e ? e.code : 'internal', e ? e.message : `The server answered ${res.status}.`, e && e.detail);
  }
  return json;
}

const enc = encodeURIComponent;

export const api = {
  health: () => request('GET', '/api/health'),
  state: () => request('GET', '/api/state'),

  skills: () => request('GET', '/api/skills'),
  skill: (name) => request('GET', `/api/skills/${enc(name)}`),
  saveSkill: (name, skillMd, placement = {}) => request('PUT', `/api/skills/${enc(name)}`, { skillMd, ...placement }),
  removeSkill: (name) => request('DELETE', `/api/skills/${enc(name)}`),
  useSkill: (name) => request('POST', `/api/skills/${enc(name)}/use`, {}),
  scanRepo: (url) => request('POST', '/api/skills/scan', { url }),
  fetchSkills: (body) => request('POST', '/api/skills/fetch', body),
  importFiles: (body) => request('POST', '/api/import', body),

  projects: () => request('GET', '/api/projects'),
  addProject: (path, permissions) => request('POST', '/api/projects', { path, permissions }),
  setPermissions: (id, permissions) => request('PUT', `/api/projects/${enc(id)}/permissions`, { permissions }),
  stats: () => request('GET', '/api/stats'),
  pickFolder: () => request('POST', '/api/system/pick-folder', {}),
  createProject: (body) => request('POST', '/api/projects/create', body),
  project: (id, open = false) => request('GET', `/api/projects/${enc(id)}${open ? '?open=1' : ''}`),
  removeProject: (id) => request('DELETE', `/api/projects/${enc(id)}`),
  health_of: (id) => request('GET', `/api/projects/${enc(id)}/health`),
  plan: (id) => request('GET', `/api/projects/${enc(id)}/plan`),
  savePlan: (id, plan) => request('PUT', `/api/projects/${enc(id)}/plan`, { plan }),
  file: (id, path) => request('GET', `/api/projects/${enc(id)}/file?path=${enc(path)}`),
  chatLog: (id, nodeId = '', engine = '') => request('GET', `/api/projects/${enc(id)}/chat?nodeId=${enc(nodeId)}&engine=${enc(engine)}`),
  resetChat: (id, nodeId = '', engine = '') => request('DELETE', `/api/projects/${enc(id)}/chat?nodeId=${enc(nodeId)}&engine=${enc(engine)}`),
  settings: () => request('GET', '/api/settings'),
  update: (check = false) => request('GET', `/api/update?check=${check ? 1 : 0}`),
  applyUpdate: () => request('POST', '/api/update', {}),
  saveSettings: (patch) => request('PUT', '/api/settings', patch),
  shortcut: (body) => request('POST', '/api/desktop/shortcut', body),
  desktopStatus: (projectId = '') => request('GET', `/api/desktop/status?projectId=${enc(projectId)}`),
  openWindow: (kind, projectId, hash, tile) => request('POST', '/api/desktop/open', { kind, projectId, hash, tile }),
  guide: (message, engine) => request('POST', '/api/guide', { message, engine }),
  cost: (id) => request('GET', `/api/projects/${enc(id)}/cost`),
  catalog: (q = '', type = '') => request('GET', `/api/catalog?q=${enc(q)}&type=${enc(type)}`),
  catalogRebuild: () => request('POST', '/api/catalog/rebuild', {}),
  catalogDescribe: () => request('POST', '/api/catalog/describe', {}),
  catalogIndex: (url) => request('POST', '/api/catalog/index', { url }),
  connections: (projectId = '') => request('GET', `/api/connections?projectId=${enc(projectId)}`),
  testConnection: (body) => request('POST', '/api/connections/test', body),
  fixConnection: (body) => request('POST', '/api/connections/fix', body),
  checkConnection: (body) => request('POST', '/api/connections/check', body),
  security: () => request('GET', '/api/security'),
  vault: () => request('GET', '/api/vault'),
  vaultSet: (name, body) => request('PUT', `/api/vault/${enc(name)}`, body),
  vaultRemove: (name) => request('DELETE', `/api/vault/${enc(name)}`),
  vaultImport: (body) => request('POST', '/api/vault/import', body),
  widgetsFeed: (theme = 'dark') => request('GET', `/api/widgets/feed?theme=${enc(theme)}`),
  desktopWidgets: (action) => request('POST', '/api/desktop/widgets', { action }),
  usage: (days = 30, fresh = false) => request('GET', `/api/usage?days=${days}&fresh=${fresh ? 1 : 0}`),
  pulse: (id) => request('GET', `/api/projects/${enc(id)}/pulse`),
  git: (id, fresh = false) => request('GET', `/api/projects/${enc(id)}/git?fresh=${fresh ? 1 : 0}`),
  setGithub: (id, on) => request('PUT', `/api/projects/${enc(id)}/git/github`, { on }),
  linkChat: (id, nodeId, sessionId) => request('POST', `/api/projects/${enc(id)}/chat/link`, { nodeId: nodeId || null, sessionId }),
  history: (id, nodeId = '') => request('GET', `/api/projects/${enc(id)}/history?nodeId=${enc(nodeId)}`),
  historyOne: (id, sessionId, run = '') => request('GET', `/api/projects/${enc(id)}/history/${enc(sessionId)}?run=${enc(run)}`),

  previewChanges: (projectId, ops) => request('POST', '/api/changes/preview', { projectId, ops }),
  applyChanges: (id) => request('POST', '/api/changes/apply', { id }),

  /* ---- engines, approvals and questions (the Inbox) ---- */
  engines: () => request('GET', '/api/engines'),
  checkEngines: () => request('POST', '/api/engines/check', {}),
  requests: (status = 'pending', projectId = '') => request('GET', `/api/requests?status=${enc(status)}${projectId ? '&projectId=' + enc(projectId) : ''}`),
  respond: (id, body) => request('POST', `/api/requests/${enc(id)}/respond`, body),
  alerts: (status = 'open') => request('GET', `/api/alerts?status=${enc(status)}`),
  live: (id) => request('GET', `/api/projects/${enc(id)}/live`),

  /* ---- templates, workflows and their versions ---- */
  templates: () => request('GET', '/api/templates'),
  createTemplate: (body) => request('POST', '/api/templates', body),
  importTemplate: (body) => request('POST', '/api/templates/import', body),
  template: (id) => request('GET', `/api/templates/${enc(id)}`),
  saveTemplate: (id, body) => request('PUT', `/api/templates/${enc(id)}`, body),
  removeTemplate: (id) => request('DELETE', `/api/templates/${enc(id)}`),
  workflow: (id) => request('GET', `/api/projects/${enc(id)}/workflow`),
  saveWorkflow: (id, body) => request('PUT', `/api/projects/${enc(id)}/workflow`, body),
  restoreWorkflow: (id, version) => request('POST', `/api/projects/${enc(id)}/workflow/restore`, { version }),
  suggestWorkflow: (id, body) => request('POST', `/api/projects/${enc(id)}/workflow/suggest`, body),

  /** App-wide event stream (requests, runs, usage). Calls onEvent(name, data); returns { close() }. Reconnects itself. */
  events(onEvent) {
    let stop = false;
    let ctl = null;
    const loop = async () => {
      while (!stop) {
        ctl = new AbortController();
        try {
          const res = await fetch('/api/events', { method: 'GET', signal: ctl.signal });
          if (!String(res.headers.get('content-type')).startsWith('text/event-stream')) throw new Error('not a stream');
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const ev = /^event: (.*)$/m.exec(block);
              const data = /^data: (.*)$/m.exec(block);
              if (ev && data) { try { onEvent(ev[1], JSON.parse(data[1])); } catch { /* skip a bad frame */ } }
            }
          }
        } catch { /* fall through to the pause */ }
        if (!stop) await new Promise((r) => setTimeout(r, 2000));
      }
    };
    loop();
    return { close() { stop = true; ctl?.abort(); } };
  },

  stopChat: (projectId, nodeId) => request('POST', '/api/chat/stop', { projectId, nodeId }),
  advise: (body) => request('POST', '/api/advisor', body),

  /**
   * Stream a chat turn. Calls onEvent(name, data) for session/text/tool/notice/done/error/stopped.
   * Resolves when the stream ends. Rejects with ApiError for errors that happen before the stream starts.
   */
  async chat(body, onEvent, signal) {
    let res;
    try {
      res = await fetch('/api/chat', { method: 'POST', headers: { 'X-Circle': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    } catch (e) {
      if (e.name === 'AbortError') return;
      throw new ApiError(0, 'offline', 'Circle Studio\'s server is not reachable.');
    }
    if (!String(res.headers.get('content-type')).startsWith('text/event-stream')) {
      let json = null;
      try { json = await res.json(); } catch { /* ignore */ }
      const e = json && json.error;
      throw new ApiError(res.status, e ? e.code : 'internal', e ? e.message : `The server answered ${res.status}.`, e && e.detail);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const flush = (block) => {
      if (!block.trim() || block.startsWith(':')) return;
      const ev = /^event: (.*)$/m.exec(block);
      const data = /^data: (.*)$/m.exec(block);
      if (ev && data) { try { onEvent(ev[1], JSON.parse(data[1])); } catch { /* skip a bad frame */ } }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { flush(buf.slice(0, i)); buf = buf.slice(i + 2); }
      }
      flush(buf);
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    }
  },
};
