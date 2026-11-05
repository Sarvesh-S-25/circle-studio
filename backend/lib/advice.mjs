// Provider-neutral, read-only structured work for the helper, Advisor, skill finder and connection advice.
import fs from 'node:fs';
import path from 'node:path';
import { ADVISOR_SCHEMA } from './claude.mjs';
import { badRequest, notReady, upstream, busy } from './errors.mjs';
import { redact } from './secrets.mjs';

export function validateShape(value, schema, where = 'answer') {
  if (!schema || typeof schema !== 'object') return;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  if (types.length && !types.includes(kind) && !(kind === 'integer' && types.includes('number'))) throw upstream(`${where} has the wrong type.`);
  if (schema.enum && !schema.enum.includes(value)) throw upstream(`${where} contains an unsupported value.`);
  if (kind === 'string' && (value.length > (schema.maxLength ?? 100000) || value.length < (schema.minLength ?? 0))) throw upstream(`${where} has an invalid length.`);
  if (kind === 'object') {
    for (const key of schema.required || []) if (!(key in value)) throw upstream(`${where}.${key} is missing.`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.additionalProperties === false && !(key in (schema.properties || {}))) throw upstream(`${where} contains an unexpected property.`);
      validateShape(item, schema.properties?.[key], `${where}.${key}`);
    }
  }
  if (kind === 'array') {
    if (value.length > (schema.maxItems ?? 1000)) throw upstream(`${where} has too many items.`);
    value.forEach((item, i) => validateShape(item, schema.items, `${where}[${i}]`));
  }
  if ((kind === 'number' || kind === 'integer') && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) throw upstream(`${where} is outside its allowed range.`);
}

export function createAdvice(app) {
  const active = new Map();
  async function choose(engine) {
    if (engine && !app.engines.adapter(engine)) throw badRequest('Unknown engine.');
    const preferred = engine || app.settings.get().preferredEngine || 'claude';
    const first = await app.engines.info(preferred);
    if (first?.usable && (preferred === 'claude' || first.capabilities?.structuredOutput)) return preferred;
    if (engine) throw notReady(`${first?.label || engine} is not ready for structured work.`);
    const all = await app.engines.list();
    const ready = all.find((e) => e.usable && (e.id === 'claude' || e.capabilities?.structuredOutput));
    if (!ready) throw notReady('No signed-in engine supports this task. Set up Codex or Claude in Let’s begin.');
    return ready.id;
  }
  return {
    active,
    choose,
    async run(options) {
      const engine = await choose(options.engine);
      if (engine === 'claude') return app.claude.advise(options);
      const adapter = app.engines.adapter(engine);
      const key = options.key || 'advice';
      if (active.has(key)) throw busy('This task is already running.');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs || 180_000);
      const schema = options.schema || ADVISOR_SCHEMA;
      let text = '';
      let error = null;
      let models = [];
      const root = options.root || path.join(app.config.dataDir, 'advice');
      fs.mkdirSync(root, { recursive: true });
      active.set(key, controller);
      const started = Date.now();
      try {
        const catalog = await app.engines.info(engine);
        const model = catalog.models?.includes(options.model) ? options.model : undefined;
        const result = await adapter.runTurn({ cwd: root, prompt: `${redact(options.prompt)}\n\nReturn only a JSON object matching this schema:\n${JSON.stringify(schema)}`, model, schema, permissions: { shell: false, write: false }, systemPrompt: 'Read-only advisory task. Do not run commands, edit files, call external tools, or disclose secrets.', signal: controller.signal,
          onRequest: async () => ({ decision: 'deny', message: 'This task returns advice only.' }),
          emit: (name, data) => {
            if (name === 'text') { text += data.delta || ''; if (text.length > 1024 * 1024) { error = 'The answer exceeded the supported size.'; controller.abort(); } }
            if (name === 'error') error = data.message;
            if (name === 'done') models = data.models || [];
          },
        });
        if (error || result.status !== 'done') throw upstream(redact(error || 'The advisory task was interrupted.'));
        let data;
        try { data = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); } catch { throw upstream('The engine did not return valid structured output. Try again or choose another engine.'); }
        validateShape(data, schema);
        return { data, models, engine, costUsd: null, ms: Date.now() - started };
      } finally { clearTimeout(timer); active.delete(key); }
    },
    stopAll() { for (const controller of active.values()) controller.abort(); },
  };
}
