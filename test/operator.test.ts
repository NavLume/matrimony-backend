import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operatorOf } from '../src/bo/operator.js';

await test('a profile run by the agency is labelled so, whatever it says it is for', () => {
  assert.equal(operatorOf('assisted', 'self'), 'agency');
  assert.equal(operatorOf('assisted', 'child'), 'agency');
});

await test('a profile run by its owner is labelled by whom it is for', () => {
  assert.equal(operatorOf('self_service', 'self'), 'self');
  assert.equal(operatorOf('self_service', 'child'), 'parent');
  assert.equal(operatorOf('self_service', 'sibling'), 'sibling');
  assert.equal(operatorOf('self_service', 'relative'), 'relative');
  assert.equal(operatorOf('self_service', 'other'), 'other');
});

await test('a missing or unknown value is taken as the person themselves', () => {
  assert.equal(operatorOf('self_service', null), 'self');
  assert.equal(operatorOf(null, 'cousin'), 'self');
});
