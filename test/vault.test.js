const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const vault = require('../src/vault');

// Build a throwaway vault dir with a tag map and a few files.
function makeTempVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
  fs.mkdirSync(path.join(dir, 'products'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'policies'), { recursive: true });
  const map = {
    inverters: {
      file: 'products/inverters.md',
      title: 'Inverters',
      description: 'inverter questions',
      keywords: ['inverter', 'kva', 'hybrid']
    },
    warranty: {
      file: 'policies/warranty.md',
      title: 'Warranty policy',
      description: 'warranty terms',
      keywords: ['warranty', 'guarantee']
    },
    empty_topic: {
      file: 'products/empty.md',
      title: 'Empty placeholder',
      description: 'still all TODO',
      keywords: ['emptyplaceholderword']
    },
    missing_file: {
      file: 'products/does-not-exist.md',
      title: 'Missing',
      description: 'file was deleted',
      keywords: ['missingfileword']
    }
  };
  fs.writeFileSync(path.join(dir, 'tag-map.json'), JSON.stringify(map, null, 2));
  fs.writeFileSync(
    path.join(dir, 'products', 'inverters.md'),
    '%%\nediting instructions here\n%%\n# Inverters\n\n## What we carry\nDeye hybrid inverters, single phase 3kW to 16kW.\n\n## Rules of thumb\nA typical home runs on 5kW to 8kW.\n'
  );
  fs.writeFileSync(
    path.join(dir, 'policies', 'warranty.md'),
    '# Warranty policy\n\nInverters carry a 2 year warranty.\nBatteries carry a 5 year warranty.\n[TODO: add panel warranty]\n'
  );
  fs.writeFileSync(
    path.join(dir, 'products', 'empty.md'),
    '%%\ninstructions\n%%\n# Empty placeholder\n\n## Section\n[TODO: fill this in]\n\n## Another\n[TODO: fill this too]\n'
  );
  return dir;
}

beforeEach(() => {
  vault.clearCacheForTests();
});

test('sanitizeTags keeps only known tags, lowercased, deduped, capped at 3', () => {
  const dir = makeTempVault();
  const out = vault.sanitizeTags(
    ['Inverters', 'warranty', 'warranty', 'not_a_tag', 'empty_topic', 'missing_file'],
    dir
  );
  assert.deepStrictEqual(out, ['inverters', 'warranty', 'empty_topic']);
});

test('sanitizeTags handles garbage input', () => {
  const dir = makeTempVault();
  assert.deepStrictEqual(vault.sanitizeTags(null, dir), []);
  assert.deepStrictEqual(vault.sanitizeTags('inverters', dir), []);
  assert.deepStrictEqual(vault.sanitizeTags([null, 42, {}], dir), []);
});

test('buildKnowledgeBlock injects matching files with delimiters', () => {
  const dir = makeTempVault();
  const block = vault.buildKnowledgeBlock(['inverters', 'warranty'], null, { dir });
  assert.ok(block.text.startsWith('<business_knowledge>'));
  assert.ok(block.text.trimEnd().endsWith('</business_knowledge>'));
  assert.ok(block.text.includes('Deye hybrid inverters'));
  assert.ok(block.text.includes('2 year warranty'));
  assert.ok(block.estTokens > 0);
  assert.deepStrictEqual(block.tags, ['inverters', 'warranty']);
});

test('editor scaffolding is stripped: %% comment blocks and TODO lines never injected', () => {
  const dir = makeTempVault();
  const block = vault.buildKnowledgeBlock(['inverters', 'warranty'], null, { dir });
  assert.ok(!block.text.includes('editing instructions'));
  assert.ok(!block.text.includes('[TODO'));
});

test('an all-TODO placeholder file contributes nothing', () => {
  const dir = makeTempVault();
  const block = vault.buildKnowledgeBlock(['empty_topic'], null, { dir });
  assert.strictEqual(block.text, '');
  assert.strictEqual(block.estTokens, 0);
});

test('a missing file is skipped without throwing, other tags still load', () => {
  const dir = makeTempVault();
  const block = vault.buildKnowledgeBlock(['missing_file', 'warranty'], null, { dir });
  assert.ok(block.text.includes('2 year warranty'));
  assert.ok(!block.text.includes('does-not-exist'));
});

test('keyword fallback finds topics when the classifier gave no tags', () => {
  const dir = makeTempVault();
  const block = vault.buildKnowledgeBlock([], 'what warranty do you give on the hybrid inverter?', { dir });
  assert.ok(block.tags.includes('warranty'));
  assert.ok(block.tags.includes('inverters'));
  assert.ok(block.text.includes('2 year warranty'));
});

test('no tags and no keyword hits means empty block', () => {
  const dir = makeTempVault();
  const block = vault.buildKnowledgeBlock([], 'good morning', { dir });
  assert.strictEqual(block.text, '');
});

test('missing vault dir is fail-open: empty block, no throw', () => {
  const block = vault.buildKnowledgeBlock(['inverters'], 'inverter please', {
    dir: path.join(os.tmpdir(), 'vault-test-does-not-exist-' + Date.now())
  });
  assert.strictEqual(block.text, '');
  assert.strictEqual(block.estTokens, 0);
});

test('token budget is enforced and truncation lands on a line boundary', () => {
  const dir = makeTempVault();
  // A big file: 400 lines of ~50 chars = ~20000 chars = ~5000 tokens.
  const bigLines = [];
  for (let i = 0; i < 400; i++) bigLines.push(`Fact number ${i}: this line is filler knowledge text.`);
  fs.writeFileSync(path.join(dir, 'products', 'inverters.md'), '# Inverters\n' + bigLines.join('\n'));
  const block = vault.buildKnowledgeBlock(['inverters'], null, { dir });
  // Budget default is 1000 tokens = 4000 chars; allow wrapper overhead.
  assert.ok(block.estTokens <= 1200, `est ${block.estTokens} tokens exceeds budget`);
  assert.ok(block.text.includes('(knowledge file truncated for length)'));
  // No half-line: every "Fact number" line present must be complete.
  const lines = block.text.split('\n').filter(l => l.startsWith('Fact number'));
  for (const l of lines) assert.ok(/filler knowledge text\.$/.test(l), `cut mid-line: "${l}"`);
});

test('path traversal in tag-map file entries is refused', () => {
  const dir = makeTempVault();
  const map = JSON.parse(fs.readFileSync(path.join(dir, 'tag-map.json'), 'utf8'));
  map.evil = { file: '../../etc/passwd', title: 'Evil', description: 'x', keywords: ['evilword'] };
  fs.writeFileSync(path.join(dir, 'tag-map.json'), JSON.stringify(map));
  vault.clearCacheForTests();
  const block = vault.buildKnowledgeBlock(['evil'], null, { dir });
  assert.strictEqual(block.text, '');
});

test('buildClassifierTagBlock lists every tag with its description', () => {
  const dir = makeTempVault();
  const block = vault.buildClassifierTagBlock({ dir });
  assert.ok(block.includes('topic_tags'));
  assert.ok(block.includes('- inverters: inverter questions'));
  assert.ok(block.includes('- warranty: warranty terms'));
  assert.ok(block.includes('0 to 3'));
});

test('buildClassifierTagBlock is empty when the vault is missing', () => {
  const block = vault.buildClassifierTagBlock({
    dir: path.join(os.tmpdir(), 'vault-test-missing-' + Date.now())
  });
  assert.strictEqual(block, '');
});

test('the real repo vault parses and every mapped file exists', () => {
  const repoVault = path.join(__dirname, '..', 'vault');
  const map = vault.loadTagMap(repoVault);
  assert.ok(map, 'repo vault/tag-map.json should parse');
  for (const [tag, entry] of Object.entries(map)) {
    assert.ok(entry.file, `tag ${tag} has a file`);
    assert.ok(entry.description, `tag ${tag} has a description`);
    assert.ok(
      fs.existsSync(path.join(repoVault, entry.file)),
      `mapped file exists for tag ${tag}: ${entry.file}`
    );
  }
  // Placeholder files are all TODO right now, so the repo vault must inject
  // NOTHING until the owner fills them in (zero token cost at ship time).
  const block = vault.buildKnowledgeBlock(Object.keys(map).slice(0, 3), null, { dir: repoVault });
  assert.strictEqual(block.text, '');
});

test('classifier fallback shape carries topic_tags', () => {
  // Guards the contract: classify() merges parsed output over the fallback,
  // so the fallback must define topic_tags for downstream code.
  const claudeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'claude.js'), 'utf8');
  assert.ok(/topic_tags:\s*\[\]/.test(claudeSrc));
  assert.ok(/vault\.sanitizeTags\(parsed\.topic_tags\)/.test(claudeSrc));
});
