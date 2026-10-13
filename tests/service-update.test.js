'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { updateServiceInList } = require('../lib/service-update.js');
const { service } = require('../lib/input-validation.js');

test('Dienst bearbeiten behält ID und ändert die Felder', () => {
  const list = [{ id: 'a', name: 'A', url: 'https://a.test/', icon: 'a.png', color: '#111111', group: 'streaming' }, { id: 'b', name: 'B', url: 'https://b.test/', icon: 'b.png' }];
  const input = service({ name: 'A neu', url: 'https://a2.test', icon: 'x.png', color: '#222222', group: 'mediathek' });
  const { services, service: updated } = updateServiceInList(list, 'a', input);
  assert.equal(updated.id, 'a');
  assert.equal(services[0].name, 'A neu');
  assert.equal(services[0].url, 'https://a2.test/');
  assert.equal(services[0].group, 'mediathek');
  assert.equal(services[1], list[1]);
  assert.equal(list[0].name, 'A');
});

test('Dienst bearbeiten: unbekannte ID wirft', () => {
  assert.throws(() => updateServiceInList([], 'x', service({ name: 'X', url: 'https://x.test' })), /nicht gefunden/);
});
