// Answers that came back while no Circle Studio window was open, or to something you said from the desktop: the
// desktop host shows each as a card to read and answer right there. Only the newest per chat is kept, a few at most,
// in memory (the words themselves are read from the chat when the card asks, so nothing is copied here).
import { randomBytes } from 'node:crypto';

const MAX = 4;

export class Replies {
  constructor() { this.items = []; }

  /** A chat just answered: one card per chat, the newest. */
  add({ projectId, nodeId = null, engine = 'claude', at = new Date().toISOString() }) {
    this.items = this.items.filter((r) => !(r.projectId === projectId && r.nodeId === nodeId));
    this.items.push({ id: randomBytes(6).toString('hex'), projectId, nodeId, engine, at });
    if (this.items.length > MAX) this.items = this.items.slice(-MAX);
  }

  list() { return this.items.slice(); }

  dismiss(id) {
    const before = this.items.length;
    this.items = this.items.filter((r) => r.id !== id);
    return before !== this.items.length;
  }

  /** You answered that chat (from anywhere): its card has done its job. */
  clear(projectId, nodeId = null) { this.items = this.items.filter((r) => !(r.projectId === projectId && r.nodeId === nodeId)); }
}
