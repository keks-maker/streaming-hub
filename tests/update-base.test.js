'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveUpdateApiBase, resolveReleasesApiUrl, DEFAULT_UPDATE_API_BASE } = require('../lib/update-base.js');

const env = url => ({ STREAMING_HUB_UPDATE_URL: url });

test('update-base: ohne Override GitHub', () => {
  assert.equal(resolveUpdateApiBase({}, true), DEFAULT_UPDATE_API_BASE);
  assert.equal(resolveUpdateApiBase({}, false), DEFAULT_UPDATE_API_BASE);
});

test('update-base: gepackt nur lokales http', () => {
  assert.equal(resolveUpdateApiBase(env('http://127.0.0.1:8080/'), true), 'http://127.0.0.1:8080');
  assert.equal(resolveUpdateApiBase(env('http://localhost:1'), true), 'http://localhost:1');
  assert.equal(resolveUpdateApiBase(env('https://evil.example'), true), DEFAULT_UPDATE_API_BASE);
  assert.equal(resolveUpdateApiBase(env('http://evil.example'), true), DEFAULT_UPDATE_API_BASE);
});

test('update-base: ungepackt beliebiges http(s), Müll wird ignoriert', () => {
  assert.equal(resolveUpdateApiBase(env('https://mock.example'), false), 'https://mock.example');
  assert.equal(resolveUpdateApiBase(env('file:///etc'), false), DEFAULT_UPDATE_API_BASE);
  assert.equal(resolveUpdateApiBase(env('kaputt'), false), DEFAULT_UPDATE_API_BASE);
});

test('update-base: Helfer-Releases-URL folgt derselben Regel', () => {
  const e = url => ({ STREAMING_HUB_RELEASES_API_URL: url });
  assert.equal(resolveReleasesApiUrl({}, true), undefined);
  assert.equal(resolveReleasesApiUrl(e('http://127.0.0.1:8080/x/'), true), 'http://127.0.0.1:8080/x');
  assert.equal(resolveReleasesApiUrl(e('https://evil.example/r'), true), undefined);
  assert.equal(resolveReleasesApiUrl(e('http://evil.example/r'), true), undefined);
  assert.equal(resolveReleasesApiUrl(e('ftp://x'), false), undefined);
  assert.equal(resolveReleasesApiUrl(e('https://test.example/r'), false), 'https://test.example/r');
});
