// Writes ThirdPartyNotices.txt for the shipped bundles. The bundles are minified with license
// comments stripped, so attribution lives here instead. Package lists come from esbuild
// metafiles, so only code that actually ships is listed.
//   node scripts/notices.mjs <out-file> <metafile>...
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [out, ...metas] = process.argv.slice(2);
if (!out || !metas.length) {
  console.error('usage: node scripts/notices.mjs <out-file> <metafile>...');
  process.exit(1);
}

const pkgDirs = new Set();
for (const meta of metas) {
  const { inputs } = JSON.parse(readFileSync(meta, 'utf8'));
  const base = dirname(resolve(meta));
  for (const input of Object.keys(inputs)) {
    const m = input.replace(/\\/g, '/').match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (m) pkgDirs.add(resolve(base, '..', m[1]));
  }
}

const sections = [];
const seen = new Set();
for (const dir of [...pkgDirs].sort()) {
  const pkgFile = join(dir, 'package.json');
  if (!existsSync(pkgFile)) continue;
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  if (pkg.name?.startsWith('@agentic-whiteboard/') || seen.has(`${pkg.name}@${pkg.version}`))
    continue;
  seen.add(`${pkg.name}@${pkg.version}`);
  const licenseFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  const text = licenseFile
    ? readFileSync(join(dir, licenseFile), 'utf8').trim()
    : `License: ${pkg.license ?? 'see package'}`;
  const source = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  sections.push(
    `${pkg.name}@${pkg.version} (${pkg.license ?? 'unknown'})${source ? `\nSource: ${source}` : ''}\n\n${text}`,
  );
}

writeFileSync(
  out,
  `This software includes the following third-party packages. Their licenses follow.\n\n${'='.repeat(78)}\n\n` +
    sections.join(`\n\n${'='.repeat(78)}\n\n`) +
    '\n',
);
console.log(`Wrote ${out} (${sections.length} packages)`);
