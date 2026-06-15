'use strict';
// Run with: node --test test/github_commit.test.js
const { test } = require('node:test');
const assert = require('node:assert');

const {
  githubContentsUrl,
  encodeContentBase64,
  buildPutBody,
} = require('../src/github_commit');

test('githubContentsUrl builds the contents API path', () => {
  assert.equal(
    githubContentsUrl('owner/repo', 'src/prompts/learned-playbook.md'),
    'https://api.github.com/repos/owner/repo/contents/src/prompts/learned-playbook.md'
  );
});

test('encodeContentBase64 round-trips utf8', () => {
  const b64 = encodeContentBase64('hello world');
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), 'hello world');
});

test('buildPutBody includes sha only when provided', () => {
  const withSha = buildPutBody({ content: 'x', branch: 'main', sha: 'abc', message: 'm' });
  assert.equal(withSha.sha, 'abc');
  assert.equal(withSha.branch, 'main');
  assert.equal(withSha.message, 'm');
  assert.equal(Buffer.from(withSha.content, 'base64').toString('utf8'), 'x');

  const noSha = buildPutBody({ content: 'x', branch: 'main', sha: null, message: 'm' });
  assert.equal('sha' in noSha, false);
});
