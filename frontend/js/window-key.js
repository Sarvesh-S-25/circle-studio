// Pure identity shared by the server window manager and the browser tile entry point.
export function tileWindowKey({ kind, size, projectId, engine, nodeId, conversationId }) {
  const base = `tile:${kind}:${size}${projectId ? `:${projectId}` : ''}`;
  if (!engine && !nodeId && !conversationId) return base;
  const selection = btoa(`${engine || ''}|${nodeId || ''}|${conversationId || ''}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${base}:t${selection}`;
}
