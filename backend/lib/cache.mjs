// A small LRU with explicit entry and byte budgets. Values are derived data and can always be rebuilt.
export class BoundedCache {
  constructor({ entries = 256, bytes = 16 * 1024 * 1024 } = {}) { this.entries = entries; this.byteLimit = bytes; this.map = new Map(); this.bytes = 0; }
  get size() { return this.map.size; }
  has(key) { return this.map.has(key); }
  get(key) { const hit = this.map.get(key); if (!hit) return undefined; this.map.delete(key); this.map.set(key, hit); return hit.value; }
  set(key, value) {
    this.delete(key);
    const bytes = Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(String(key));
    if (bytes > this.byteLimit) return this;
    this.map.set(key, { value, bytes }); this.bytes += bytes;
    while (this.map.size > this.entries || this.bytes > this.byteLimit) this.delete(this.map.keys().next().value);
    return this;
  }
  delete(key) { const hit = this.map.get(key); if (hit) this.bytes -= hit.bytes; return this.map.delete(key); }
  clear() { this.map.clear(); this.bytes = 0; }
}
