// Main + Backup -> the engine chain that is written to consult.config.json. Pure, so it can be tested.

/**
 * main: the engine that answers first; backup: the one that takes over ('' for none);
 * extras: other engines the file already lists (kept, in order, unless the backup is "self");
 * selfEnd: the file's chain already ended in "self".
 * "self" (Claude itself) can only be last, and as Main it is the whole chain.
 */
export function buildChain({ main, backup = '', extras = [], selfEnd = false }) {
  if (main === 'self') return ['self'];
  const chain = [main];
  if (backup && backup !== 'self' && backup !== main) chain.push(backup);
  if (backup !== 'self') for (const e of extras) if (e !== 'self' && !chain.includes(e)) chain.push(e);
  if (backup === 'self' || selfEnd) chain.push('self');
  return chain;
}
