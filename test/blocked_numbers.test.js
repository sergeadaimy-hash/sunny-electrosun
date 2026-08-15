const test = require('node:test');
const assert = require('node:assert');

const security = require('../src/security');

test('parseBlockedNumbers handles empty and missing values', () => {
  assert.deepStrictEqual([...security.parseBlockedNumbers('')], []);
  assert.deepStrictEqual([...security.parseBlockedNumbers(undefined)], []);
  assert.deepStrictEqual([...security.parseBlockedNumbers(null)], []);
});

test('parseBlockedNumbers splits on commas, semicolons and newlines', () => {
  const set = security.parseBlockedNumbers('2349159787464, 2348011122233;966500000000\n2347000000001');
  assert.strictEqual(set.size, 4);
  assert.ok(set.has('2349159787464'));
  assert.ok(set.has('2348011122233'));
  assert.ok(set.has('966500000000'));
  assert.ok(set.has('2347000000001'));
});

test('parseBlockedNumbers normalizes formatting to digits', () => {
  const set = security.parseBlockedNumbers('+234 915 978 7464');
  assert.ok(set.has('2349159787464'));
});

test('isBlockedNumber matches a listed sender in any format', () => {
  const raw = '2349159787464';
  assert.strictEqual(security.isBlockedNumber('2349159787464', raw), true);
  assert.strictEqual(security.isBlockedNumber('+2349159787464', raw), true);
  assert.strictEqual(security.isBlockedNumber('234 915 978 7464', raw), true);
});

test('isBlockedNumber does not match other senders or empty input', () => {
  const raw = '2349159787464';
  assert.strictEqual(security.isBlockedNumber('2347041328055', raw), false);
  assert.strictEqual(security.isBlockedNumber('', raw), false);
  assert.strictEqual(security.isBlockedNumber(null, raw), false);
  assert.strictEqual(security.isBlockedNumber('9159787464', raw), false);
});

test('isBlockedNumber reads BLOCKED_NUMBERS from env by default', () => {
  const prev = process.env.BLOCKED_NUMBERS;
  try {
    process.env.BLOCKED_NUMBERS = '2349159787464';
    assert.strictEqual(security.isBlockedNumber('2349159787464'), true);
    assert.strictEqual(security.isBlockedNumber('2347041328055'), false);
    delete process.env.BLOCKED_NUMBERS;
    assert.strictEqual(security.isBlockedNumber('2349159787464'), false);
  } finally {
    if (prev === undefined) delete process.env.BLOCKED_NUMBERS;
    else process.env.BLOCKED_NUMBERS = prev;
  }
});
