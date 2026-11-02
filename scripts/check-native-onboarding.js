// Candidate-only verification: this branch retains the video client from a742863.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const baseline = require('../.github/native-onboarding-baseline.json');
if (baseline.base !== 'a74286340b14720e411adba7837b325e9a4d4eea') throw new Error('Unexpected native baseline commit');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(path.join(root, file));
const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
const allowed = new Set([
  'miniapp/config.js', 'miniapp/project.config.json',
  'miniapp/pages/entry/index.js', 'miniapp/pages/entry/index.wxml', 'miniapp/pages/entry/index.wxss',
  'miniapp/utils/auth.js', 'miniapp/pages/workbench/index.js', 'miniapp/pages/workbench/index.wxml',
  'miniapp/pages/catalog/index.js', 'miniapp/pages/catalog/index.wxml',
  'miniapp/test/entry-workbench.test.js', 'miniapp/test/public-entry.test.js', 'miniapp/test/onboarding.test.js',
  '.github/native-onboarding-baseline.json', '.github/workflows/native-onboarding.yml', 'scripts/check-native-onboarding.js'
]);
const changed = [...new Set([
  ...git('diff', '--name-only', baseline.base).split('\n'),
  ...git('ls-files', '--others', '--exclude-standard').split('\n')
].filter(Boolean))];
const unexpected = changed.filter(file => !allowed.has(file));
if (unexpected.length) throw new Error(`Unexpected changes outside native candidate allowlist: ${unexpected.join(', ')}`);
let unchanged = 0;
for (const row of baseline.files) {
  const actual = sha256(read(row.path));
  const baselineSource = execFileSync('git', ['show', `${baseline.base}:${row.path}`], {cwd: root});
  if (sha256(baselineSource) !== row.sourceSha256) throw new Error(`Baseline provenance mismatch: ${row.path}`);
  if (['miniapp/config.js', 'miniapp/project.config.json'].includes(row.path)) {
    if (actual !== row.preservedSha256) throw new Error(`Preserved environment mismatch: ${row.path}`);
  } else if (row.preservedSha256 !== row.sourceSha256) {
    throw new Error(`Unexpected preserved baseline difference: ${row.path}`);
  } else if (!allowed.has(row.path)) {
    if (actual !== row.preservedSha256) throw new Error(`Protected native video baseline changed: ${row.path}`);
    unchanged++;
  }
}
// Media/tab/player/save handlers inside the narrowly edited catalog page stay byte-identical.
const protectedRegions = [];
function region(file, start, end) {
  const original = execFileSync('git', ['show', `${baseline.base}:${file}`], {cwd: root, encoding:'utf8'});
  const current = read(file).toString();
  function extract(text) {
    const from = text.indexOf(start), to = end ? text.indexOf(end, from + start.length) : text.length;
    if (from < 0 || to < from) throw new Error(`Protected region missing in ${file}`);
    return text.slice(from, to);
  }
  const expected = extract(original), actual = extract(current);
  if (actual !== expected) throw new Error(`Protected catalog media region changed: ${file}: ${start}`);
  protectedRegions.push({path:file, start, end, sha256:sha256(actual)});
}
region('miniapp/pages/catalog/index.js', 'const CASE_GROUPS =', 'Page({');
region('miniapp/pages/catalog/index.js', '  onTab(event)', '  onDownloadError(error)');
region('miniapp/pages/catalog/index.js', '  async onCaseSave(event)', null);
const catalogTemplate = read('miniapp/pages/catalog/index.wxml').toString();
const oldTemplate = execFileSync('git', ['show', `${baseline.base}:miniapp/pages/catalog/index.wxml`], {cwd:root,encoding:'utf8'});
if (catalogTemplate !== oldTemplate.replace('disabled="{{pdfBusy || (loggedIn && !canDownloadSop)}}"', 'disabled="{{pdfBusy}}"')) {
  throw new Error('Catalog template changed beyond allowing SOP reminder taps');
}
const miniappFiles = git('ls-files', '--', 'miniapp').split('\n').filter(Boolean);
if (process.argv.includes('--syntax')) {
  for (const file of miniappFiles.filter(file => file.endsWith('.js'))) execFileSync(process.execPath, ['--check', file], {cwd:root,stdio:'pipe'});
  for (const file of miniappFiles.filter(file => file.endsWith('.json'))) JSON.parse(read(file));
}
const manifestIndex = process.argv.indexOf('--manifest');
if (manifestIndex >= 0) {
  if (!process.argv[manifestIndex + 1]) throw new Error('--manifest requires an output path');
  const manifest = {
    base: baseline.base, candidateCommit:git('rev-parse','HEAD'),
    protectedFileCount:unchanged, protectedRegions,
    // Git runtime paths only: generated files, credentials and dependency folders never enter a package manifest.
    files:miniappFiles.filter(file => !file.startsWith('miniapp/test/')).map(file => ({path:file,sha256:sha256(read(file))}))
  };
  fs.writeFileSync(process.argv[manifestIndex + 1], JSON.stringify(manifest,null,2)+'\n');
}
console.log(`Native candidate integrity: ${unchanged} untouched files match preserved baseline; 2 config files match preserved environment; 3 catalog media regions and video template match; ${changed.length} allowlisted changes.`);
