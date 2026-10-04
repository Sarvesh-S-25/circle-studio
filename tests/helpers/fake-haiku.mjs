// A stand-in for `claude -p --model haiku` in the condense hook's tests: reads the prompt, answers with a short
// summary that names the error line it found (so tests can check what was kept).
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const err = (input.match(/^.*ERROR.*$/m) || ['no error'])[0];
  process.stdout.write(`Summary: ran fine until ${err}`);
});
