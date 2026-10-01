// Claude API list prices, US dollars per million tokens. Source: Anthropic's first-party API price table as bundled with
// Claude Code's claude-api reference (cached 2026-09-25). Cache writes cost 1.25x the input price for the 5-minute cache
// and 2x for the 1-hour cache; cache reads cost the listed price, or 0.1x input when none is listed.
// On a Pro or Max plan you pay the subscription, not these prices: Circle Studio uses them to compare choices and to show
// what the same work would cost through the API. Other engines (Codex, Gemini, Copilot) are billed by their own services.
export const PRICES_AS_OF = '2026-09-25';

export const PRICES = {
  'claude-fable-5-1': { label: 'Fable 5.1', input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { label: 'Fable 5', input: 10, output: 50 },
  'claude-opus-5-5': { label: 'Opus 5.5', input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { label: 'Opus 5', input: 5, output: 25 },
  'claude-opus-4-8': { label: 'Opus 4.8', input: 5, output: 25 },
  'claude-opus-4-7': { label: 'Opus 4.7', input: 5, output: 25 },
  'claude-opus-4-6': { label: 'Opus 4.6', input: 5, output: 25 },
  'claude-sonnet-5-5': { label: 'Sonnet 5.5', input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { label: 'Sonnet 5', input: 2, output: 10 },
  'claude-sonnet-4-6': { label: 'Sonnet 4.6', input: 3, output: 15 },
  'claude-haiku-4-5': { label: 'Haiku 4.5', input: 1, output: 5, cacheRead: 0.1 },
};

/** What Claude Code's model aliases mean today (the current model of each family). */
export const ALIASES = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' };

/** The price row for a model id or alias (dated ids such as claude-haiku-4-5-20251001 match their family). */
export function priceOf(model) {
  if (!model) return null;
  const m = String(model).toLowerCase().replace(/\[.*\]$/, '');
  const id = ALIASES[m] || m;
  if (PRICES[id]) return { id, ...PRICES[id] };
  const hit = Object.keys(PRICES).sort((a, b) => b.length - a.length).find((k) => id.startsWith(k));
  return hit ? { id: hit, ...PRICES[hit] } : null;
}

/** Dollars for one usage record { input, output, cacheWrite5m, cacheWrite1h, cacheRead } at a model's prices. */
export function costOf(model, u) {
  const p = priceOf(model);
  if (!p) return null;
  const per = (n, price) => ((n || 0) / 1e6) * price;
  return per(u.input, p.input) + per(u.output, p.output) + per(u.cacheWrite5m, p.input * 1.25) + per(u.cacheWrite1h, p.input * 2) + per(u.cacheRead, p.cacheRead ?? p.input * 0.1);
}

/** Rough tokens for a text: about four characters a token for English and code. */
export const tokensOf = (text) => Math.ceil(String(text || '').length / 4);
