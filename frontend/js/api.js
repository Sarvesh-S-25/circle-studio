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
      signal: AbortSignal.timeout(method === 'GET' ? 35_000 : 360_000),
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
function attachment(method, path) { if (method !== 'GET') throw new Error('Attachments use GET.'); return path; }

export const api = {
  chatQueue: (projectId, nodeId = '') => request('GET', `/api/chat/queue?projectId=${enc(projectId)}&nodeId=${enc(nodeId)}`),
  queueChat: (body) => request('POST', '/api/chat/queue', body),
  diagnostics: (processes = false) => request('GET', `/api/system/diagnostics?processes=${processes ? 1 : 0}`),
  testNotification: (engine = 'codex') => request('POST', '/api/system/notifications/test', { engine }),
  storage: () => request('GET', '/api/storage'),
  backup: (body = {}) => request('POST', '/api/storage/backup', body),
  backupDownload: (token) => attachment('GET', `/api/storage/download/${enc(token)}`),
  cleanup: (body = {}) => request('POST', '/api/storage/cleanup', body),
  reindexHistory: () => request('POST', '/api/storage/reindex', {}),
  selectChat: (id, engine, nodeId, model, reasoning) => request('POST', `/api/projects/${enc(id)}/chat/select`, { engine, nodeId, model, reasoning }),
  restore: (body) => request('POST', '/api/storage/restore', body),
  progress: (id) => request('GET', `/api/projects/${enc(id)}/progress`),
  saveTask: (id, task) => request('POST', `/api/projects/${enc(id)}/progress`, task),
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
  chatLive: (id, nodeId = '') => request('GET', `/api/projects/${enc(id)}/chat/live?nodeId=${enc(nodeId)}`),
  resetChat: (id, nodeId = '', engine = '') => request('DELETE', `/api/projects/${enc(id)}/chat?nodeId=${enc(nodeId)}&engine=${enc(engine)}`),
  archiveChat: (id, conversationId, engine, nodeId = '', archived = true) => request('DELETE', `/api/projects/${enc(id)}/chat?nodeId=${enc(nodeId)}&engine=${enc(engine)}&conversationId=${enc(conversationId)}&archived=${archived ? 1 : 0}`),
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
  connections: (projectId = '', effective = '') => request('GET', `/api/connections?projectId=${enc(projectId)}&effective=${enc(effective)}`),
  manageConnections: () => request('GET', '/api/connections/manage'),
  mods: (projectId = '') => request('GET', `/api/mods?projectId=${enc(projectId)}`),
  modGeneral: (plugin, on) => request('POST', '/api/mods/general', { plugin, on }),
  modDetails: (plugin) => request('POST', '/api/mods/details', { plugin }),
  modStarters: () => request('GET', '/api/mods/starters'),
  modCheck: (plugin) => request('POST', '/api/mods/check', { plugin }),
  planConnection: (action, projectId) => request('POST', '/api/connections/plan', { action, projectId }),
  applyConnection: (id) => request('POST', '/api/connections/apply', { id }),
  testConnection: (body) => request('POST', '/api/connections/test', body),
  fixConnection: (body) => request('POST', '/api/connections/fix', body),
  checkConnection: (body) => request('POST', '/api/connections/check', body),
  security: () => request('GET', '/api/security'),
  vault: () => request('GET', '/api/vault'),
  vaultSet: (name, body) => request('PUT', `/api/vault/${enc(name)}`, body),
  vaultRemove: (name) => request('DELETE', `/api/vault/${enc(name)}`),
  vaultImport: (body) => request('POST', '/api/vault/import', body),
  overlay: (projectId) => request('GET', `/api/overlay?projectId=${enc(projectId || '')}`),
  permHook: (engine = 'claude') => request('GET', `/api/permhook?engine=${enc(engine)}`),
  setPermHook: (on, engine = 'claude') => request('POST', '/api/permhook', { on, engine }),
  limits: (engine = '', fresh = false) => request('GET', `/api/limits?engine=${enc(engine)}&fresh=${fresh ? 1 : 0}`),
  setLimitsTap: (on) => request('POST', '/api/limits/tap', { on }),
  overlayCommand: (text, projectId, from, engine) => request('POST', '/api/overlay/command', { text, projectId, ...(from ? { from } : {}), ...(engine ? { engine } : {}) }),
  overlaySay: (projectId, text, nodeId) => request('POST', '/api/overlay/say', { projectId, text, nodeId: nodeId || undefined }),
  desktopReplies: () => request('GET', '/api/desktop/replies'),
  dismissReply: (id) => request('POST', '/api/desktop/replies/dismiss', { id }),
  // the same requests the terminal's hook sends: Settings uses them to try the cards with a sample
  terminalAsk: (body) => request('POST', '/api/hooks/permission', body),
  terminalAskWait: (id, wait = 25) => request('GET', `/api/hooks/permission/${enc(id)}?wait=${wait}`),
  releaseToTerminal: (id) => request('POST', `/api/hooks/permission/${enc(id)}/release`),
  openFolder: (projectId) => request('POST', '/api/desktop/folder', { projectId }),
  openTerminal: (projectId, mode = 'auto', options = {}) => request('POST', '/api/desktop/terminal', { projectId, mode, ...options }),
  openEditor: (projectId, nodeId) => request('POST', '/api/desktop/editor', { projectId, nodeId: nodeId || undefined }),
  widgetsFeed: (theme = 'dark') => request('GET', `/api/widgets/feed?theme=${enc(theme)}`),
  widgetChat: (projectId, nodeId = 'main', size = 'm', engine = '', conversationId = '') => request('GET', `/api/widgets/chat?projectId=${enc(projectId || '')}&nodeId=${enc(nodeId || 'main')}&size=${enc(size)}&engine=${enc(engine)}&conversationId=${enc(conversationId)}`),
  pickWidget: (index, patch) => request('POST', '/api/widgets/pick', { index, ...patch }),
  notices: (limit = 60) => request('GET', `/api/notices?limit=${limit}`),
  readNotices: (ids) => request('POST', '/api/notices/read', ids ? { ids } : {}),
  desktopWidgets: (action, extra = {}) => request('POST', '/api/desktop/widgets', { action, ...extra }),
  usage: (days = 30, fresh = false) => request('GET', `/api/usage?days=${days}&fresh=${fresh ? 1 : 0}`),
  pulse: (id) => request('GET', `/api/projects/${enc(id)}/pulse`),
  git: (id, fresh = false) => request('GET', `/api/projects/${enc(id)}/git?fresh=${fresh ? 1 : 0}`),
  setGithub: (id, on) => request('PUT', `/api/projects/${enc(id)}/git/github`, { on }),
  linkChat: (id, nodeId, sessionId, options = {}) => request('POST', `/api/projects/${enc(id)}/chat/link`, { nodeId: nodeId || null, sessionId, ...options }),
  history: (id, nodeId = '', engine = '', options = {}) => request('GET', `/api/projects/${enc(id)}/history?nodeId=${enc(nodeId)}&engine=${enc(engine)}&source=${enc(options.source || '')}&offset=${options.offset || 0}&archived=${options.archived ? 1 : 0}&cursor=${enc(options.cursor || '')}`),
  historyOne: (id, sessionId, run = '', options = {}) => request('GET', `/api/projects/${enc(id)}/history/${enc(sessionId)}?run=${enc(run)}&engine=${enc(options.engine || '')}&source=${enc(options.source || '')}&nodeId=${enc(options.nodeId || '')}&offset=${options.offset || 0}&cursor=${enc(options.cursor || '')}`),

  previewChanges: (projectId, ops) => request('POST', '/api/changes/preview', { projectId, ops }),
  applyChanges: (id) => request('POST', '/api/changes/apply', { id }),

  /* ---- engines, approvals and questions (the Inbox) ---- */
  code: () => request('GET', '/api/code'),
  restartApp: () => request('POST', '/api/restart', {}),
  engines: () => request('GET', '/api/engines'),
  checkEngines: () => request('POST', '/api/engines/check', {}),
  engineTerminal: (engine, step) => request('POST', '/api/engines/terminal', { engine, step }),
  githubSignOut: () => request('POST', '/api/github/signout', {}),
  requests: (status = 'pending', projectId = '', archived = false, cursor = '') => request('GET', `/api/requests?status=${enc(status)}${projectId ? '&projectId=' + enc(projectId) : ''}&archived=${archived ? 1 : 0}&cursor=${enc(cursor ?? '')}`),
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
  patterns: (id, workflow) => request('POST', `/api/projects/${enc(id)}/patterns`, { workflow }),
  discoverSkills: (id, body) => request('POST', `/api/projects/${enc(id)}/skills/discover`, body),

  /**
   * App-wide event stream (requests, runs, usage). Calls onEvent(name, data); returns { close() }. Reconnects itself.
   * `windowKey` says what this window shows ('app', 'board', 'widget:<id>', ...), so it is reused instead of opened twice.
   */
  events(onEvent, windowKey = '') {
    let stop = false;
    let ctl = null;
    let lastByte = Date.now();
    let retry = null;
    let wake = null;
    const loop = async () => {
      while (!stop) {
        ctl = new AbortController();
        lastByte = Date.now();
        try {
          const permission = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
          const res = await fetch(`/api/events?window=${enc(windowKey)}&notifications=${enc(permission)}`, { method: 'GET', signal: ctl.signal });
          if (!String(res.headers.get('content-type')).startsWith('text/event-stream')) throw new Error('not a stream');
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            lastByte = Date.now();
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
        if (!stop) await new Promise((r) => { wake = r; retry = setTimeout(r, 2000); });
        clearTimeout(retry); wake = null;
      }
    };
    const reconnect = () => { ctl?.abort(); wake?.(); };
    const visible = () => { if (document.visibilityState === 'visible' && Date.now() - lastByte > 30_000) reconnect(); };
    // Pings arrive every 15 seconds. A socket can survive sleep without delivering another byte.
    const watchdog = setInterval(() => { if (Date.now() - lastByte > 45_000) reconnect(); }, 15_000);
    window.addEventListener('circle:notification-permission', reconnect);
    window.addEventListener('online', reconnect);
    window.addEventListener('pageshow', visible);
    document.addEventListener('visibilitychange', visible);
    loop();
    return { close() {
      stop = true; clearInterval(watchdog); clearTimeout(retry);
      window.removeEventListener('circle:notification-permission', reconnect);
      window.removeEventListener('online', reconnect);
      window.removeEventListener('pageshow', visible);
      document.removeEventListener('visibilitychange', visible);
      reconnect();
    } };
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
