(async () => {
  const { api } = await import('/js/api.js');
  const { state } = await import('/js/state.js');
  const { openNodePanel } = await import('/js/components/graph/nodepanel.js');
  const project = (await api.project('dummy_project')).project;
  if (!project.path.includes('circle-demo-')) throw new Error('This lifecycle check requires an isolated dummy project.');
  state.engines = (await api.engines()).engines;
  const workflow = (await api.workflow(project.id)).workflow;
  const node = workflow.nodes.find((n) => n.kind === 'agent');
  const side = document.createElement('div'); side.hidden = true; document.body.append(side);
  const intervals = new Set(); const listeners = new Set();
  const original = { setInterval: window.setInterval, clearInterval: window.clearInterval, add: window.addEventListener, remove: window.removeEventListener };
  window.setInterval = function(...args) { const id = original.setInterval.apply(this, args); intervals.add(id); return id; };
  window.clearInterval = function(id) { intervals.delete(id); return original.clearInterval.call(this, id); };
  window.addEventListener = function(name, callback, ...rest) { if (['circle:requests', 'circle:progress', 'circle:run'].includes(name)) listeners.add(callback); return original.add.call(this, name, callback, ...rest); };
  window.removeEventListener = function(name, callback, ...rest) { listeners.delete(callback); return original.remove.call(this, name, callback, ...rest); };
  try {
    for (let cycle = 0; cycle < 100; cycle++) {
      const panel = openNodePanel(side, { node, workflow, project, graph: { select() {} }, tab: 'chat' });
      if (cycle % 2) await new Promise((resolve) => setTimeout(resolve, 40));
      const close = side.querySelector('[aria-label="Close the panel"]');
      if (close) close.click(); else panel.destroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const report = { cycles: 100, retainedIntervals: intervals.size, retainedChatListeners: listeners.size, passed: intervals.size === 0 && listeners.size === 0, note: 'Both immediate-close async races and mounted-chat closes, scoped to the dummy browser component. Existing global application listeners are excluded.' };
    window.__circleComponentSoak = report;
    return report;
  } finally {
    window.setInterval = original.setInterval; window.clearInterval = original.clearInterval; window.addEventListener = original.add; window.removeEventListener = original.remove;
    side.remove();
  }
})()
