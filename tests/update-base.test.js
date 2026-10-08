'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveUpdateApiBase, DEFAULT_UPDATE_API_BASE } = require('../lib/update-base.js');

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
