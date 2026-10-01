// Read what the fake CLIs logged: the arguments (and prompt) of every run.
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './project.mjs';

export const TRACE = () => path.join(tempDir('circle-trace-'), 'trace.jsonl');
export const runsOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
export const has = (args, flag) => args.includes(flag);
export const after = (args, flag) => args[args.indexOf(flag) + 1];
