// Runs `doctor --deep` against the demo dApp in one command: starts the demo
// server on a free port, checks the strict variant with a wallet that arrives
// after the page's only scan and the permissive variant with an early one,
// then stops the server. Extra arguments are passed to both runs, for example
// `npm run doctor:demo -- --browser webkit`.
// The demo is expected to produce findings, so the exit code is 2 only when a
// run itself failed and 0 otherwise.
import { main } from '../dist/node/cli/doctor.js';
import { createDemoServer } from '../examples/minimal-dapp/serve.mjs';

const extra = process.argv.slice(2);
const runs = [
  { variant: 'strict', args: ['--inject-after', '1000', '--expect', '#wallet-found'] },
  { variant: 'permissive', args: ['--expect', '#wallet-found'] },
];

const server = createDemoServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const io = { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };

let failed = false;
try {
  for (const [i, run] of runs.entries()) {
    if (i > 0) io.out(`\n${'#'.repeat(88)}\n`);
    const code = await main(['doctor', `${base}/${run.variant}/`, '--deep', ...run.args, ...extra], io);
    if (code === 2) failed = true;
  }
} finally {
  server.close();
}
process.exit(failed ? 2 : 0);
