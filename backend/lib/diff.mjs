// A small line diff (LCS on the changed middle) that produces unified-style hunks.

const CONTEXT = 3;
const MAX_CELLS = 6_000_000;

function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Edit script between two line arrays: [{t:' '|'+'|'-', text}] */
function script(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ t: ' ', text: a[i] });
  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_CELLS) {
    for (let i = start; i < endA; i++) ops.push({ t: '-', text: a[i] });
    for (let j = start; j < endB; j++) ops.push({ t: '+', text: b[j] });
  } else if (n === 0 || m === 0) {
    for (let i = start; i < endA; i++) ops.push({ t: '-', text: a[i] });
    for (let j = start; j < endB; j++) ops.push({ t: '+', text: b[j] });
  } else {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = a[start + i] === b[start + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) { ops.push({ t: ' ', text: a[start + i] }); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push({ t: '-', text: a[start + i] }); i++; }
      else { ops.push({ t: '+', text: b[start + j] }); j++; }
    }
    while (i < n) { ops.push({ t: '-', text: a[start + i] }); i++; }
    while (j < m) { ops.push({ t: '+', text: b[start + j] }); j++; }
  }
  for (let i = endA; i < a.length; i++) ops.push({ t: ' ', text: a[i] });
  return ops;
}

/**
 * Diff two LF-normalised texts.
 * Returns { added, removed, hunks:[{oldStart,oldLines,newStart,newLines,lines:[{t,text}]}] }.
 */
export function diffText(before, after) {
  const ops = script(splitLines(before ?? ''), splitLines(after ?? ''));
  let added = 0;
  let removed = 0;
  for (const o of ops) { if (o.t === '+') added++; else if (o.t === '-') removed++; }
  if (added === 0 && removed === 0) return { added, removed, hunks: [] };

  const hunks = [];
  let oldNo = 1;
  let newNo = 1;
  const pos = ops.map((o) => {
    const p = { oldNo, newNo };
    if (o.t !== '+') oldNo++;
    if (o.t !== '-') newNo++;
    return p;
  });
  const changed = [];
  ops.forEach((o, i) => { if (o.t !== ' ') changed.push(i); });
  let idx = 0;
  while (idx < changed.length) {
    let from = Math.max(0, changed[idx] - CONTEXT);
    let to = Math.min(ops.length - 1, changed[idx] + CONTEXT);
    let k = idx + 1;
    while (k < changed.length && changed[k] - CONTEXT <= to + 1) {
      to = Math.min(ops.length - 1, changed[k] + CONTEXT);
      k++;
    }
    const lines = ops.slice(from, to + 1);
    const oldLines = lines.filter((l) => l.t !== '+').length;
    const newLines = lines.filter((l) => l.t !== '-').length;
    hunks.push({
      oldStart: oldLines ? pos[from].oldNo : Math.max(0, pos[from].oldNo - 1),
      oldLines,
      newStart: newLines ? pos[from].newNo : Math.max(0, pos[from].newNo - 1),
      newLines,
      lines,
    });
    idx = k;
    from = to;
  }
  return { added, removed, hunks };
}
