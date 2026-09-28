// Checks what `npm pack` would ship: every entry point the package exports,
// the CLI with its executable bit, the docs and quirk notes, and nothing
// from the source tree, the tests or local tooling.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [report] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' }));
const files = new Map(report.files.map((f) => [f.path, f]));

const strip = (p) => p.replace(/^\.\//, '');
const required = new Set(['dist/page.js', 'README.md', 'AGENTS.md', 'LICENSE', 'quirks/README.md', 'docs/fixture-api.md', 'docs/recipes.md', 'docs/doctor.md']);
for (const target of Object.values(pkg.exports)) {
  required.add(strip(target.default));
  required.add(strip(target.types));
}
for (const bin of Object.values(pkg.bin)) required.add(strip(bin));

const problems = [];
for (const path of required) {
  if (!files.has(path)) problems.push(`missing ${path}`);
}
for (const bin of Object.values(pkg.bin)) {
  const entry = files.get(strip(bin));
  if (entry && (entry.mode & 0o111) === 0) problems.push(`${strip(bin)} is not executable`);
}
const forbidden = /^(src|test|test-browser|scripts|examples|\.github|\.superpowers|\.claude)\/|\.env|\.dev\.vars/;
for (const path of files.keys()) {
  if (forbidden.test(path)) problems.push(`ships ${path}`);
}

if (problems.length > 0) {
  console.error(`pack check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`pack check passed: ${files.size} files, ${(report.size / 1024).toFixed(1)} KB packed`);
