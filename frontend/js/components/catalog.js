// The catalog section of the Library: every building block the workflow helper can recommend (skills, agents from
// your projects and templates, connectors, reading links), each in one line, with a search like the helper's.
// "Describe with Haiku" writes the missing lines in one cheap call; "Index a link" keeps a page's text so the helper
// can quote it (retrieval, RAG).
import { api } from '../api.js';
import { h, icon, timeAgo, plural } from '../dom.js';
import { toast } from './overlay.js';

const TYPE = { pattern: ['library', 'Pattern'], skill: ['skill', 'Skill'], agent: ['agent', 'Agent'], connector: ['link', 'Connector'], link: ['globe', 'Link'] };

export function catalogSection() {
  const box = h('div', { class: 'cs-stack' });
  const q = h('input', { class: 'cs-input', type: 'search', placeholder: 'Search like the helper does, for example "review security of a web API"', 'aria-label': 'Search the catalog' });
  const url = h('input', { class: 'cs-input', type: 'url', placeholder: 'https://docs.example.com/guide', 'aria-label': 'Link to index' });
  let type = '';
  let data = null;
  let t = 0;

  async function load() {
    try { data = await api.catalog(q.value.trim(), type); } catch (e) { box.replaceChildren(h('p', { class: 'cs-soft' }, e.message)); return; }
    draw();
  }

  function draw() {
    const c = data.counts || {};
    const filters = h('div', { class: 'cs-row cs-row--wrap' }, [['', `All ${Object.values(c).reduce((a, b) => a + b, 0)}`], ...Object.keys(TYPE).map((k) => [k, `${TYPE[k][1]}s ${c[k] || 0}`])].map(([k, label]) =>
      h('button', { class: `cs-chip ${type === k ? 'cs-chip--on' : ''}`, type: 'button', 'aria-pressed': String(type === k), onclick: () => { type = k; load(); } }, label)));
    const rows = data.entries.slice(0, 120).map((e) => h('li', { class: 'cs-cat__row' }, icon(TYPE[e.type]?.[0] || 'info', 's'),
      h('div', { class: 'cs-grow' }, h('div', { class: 'cs-row cs-row--wrap' }, h('strong', {}, e.name), e.model ? h('span', { class: 'cs-pill cs-pill--quiet' }, e.model) : null,
        e.indexed ? h('span', { class: 'cs-pill cs-pill--ok' }, `indexed, ${plural(e.indexed.chunks, 'passage')}`) : null,
        e.summaryBy === 'haiku' ? h('span', { class: 'cs-pill cs-pill--info', title: 'Described by Haiku' }, 'described') : null,
        e.score ? h('span', { class: 'cs-soft cs-small' }, `match ${e.score}`) : null),
        h('div', { class: 'cs-soft cs-small' }, e.summary), h('div', { class: 'cs-soft cs-small' }, e.where)),
      e.type === 'link' && !e.indexed ? h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => index(e.url) }, 'Index') : null));
    box.replaceChildren(
      h('div', { class: 'cs-row cs-row--wrap cs-row--between' }, h('p', { class: 'cs-soft cs-small' }, `Built ${data.builtAt ? timeAgo(data.builtAt) : 'now'} from your library, projects, templates and connectors.${data.weak ? ` ${plural(data.weak, 'item')} could use a better one-line description.` : ''}`),
        h('div', { class: 'cs-row cs-row--wrap' },
          data.weak ? h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: describe }, icon('sparkle', 's'), 'Describe with Haiku') : null,
          h('button', { class: 'cs-btn cs-btn--small cs-btn--quiet', type: 'button', onclick: async () => { await api.catalogRebuild(); load(); } }, icon('refresh', 's'), 'Rebuild'))),
      q, filters,
      rows.length ? h('ul', { class: 'cs-cat__list' }, rows) : h('p', { class: 'cs-soft' }, q.value ? 'Nothing matches.' : 'Nothing yet: add skills, open projects with agents, or connect MCP servers.'),
      h('div', { class: 'cs-cat__index' }, url, h('button', { class: 'cs-btn', type: 'button', onclick: () => index(url.value.trim()) }, icon('download', 's'), 'Index a link')),
      h('p', { class: 'cs-soft cs-small' }, 'Indexing fetches the page once (that request leaves this PC) and keeps its text here, in chunks. When you ask the workflow helper, the passages that match your question are given to it, so it works from the page instead of guessing.'));
  }

  async function describe() {
    try { const r = await api.catalogDescribe(); toast(`Described ${plural(r.described, 'item')}${r.left ? `, ${r.left} left (press again)` : ''}.`, { kind: 'ok' }); } catch (e) { toast(e.message, { kind: 'danger' }); }
    load();
  }

  async function index(link) {
    if (!link) return;
    try { const r = await api.catalogIndex(link); toast(`Indexed ${r.entry.name}: ${plural(r.entry.indexed.chunks, 'passage')}.`, { kind: 'ok' }); url.value = ''; } catch (e) { toast(e.message, { kind: 'danger' }); }
    load();
  }

  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
  box.append(h('div', { class: 'cs-loading' }, icon('spinner', 's'), 'Building the catalog...'));
  load();
  return h('section', { class: 'cs-card cs-stack', 'aria-labelledby': 'lib-cat' },
    h('h2', { class: 'cs-h2', id: 'lib-cat' }, 'Catalog: what the helper can recommend'), box);
}
