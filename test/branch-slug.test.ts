import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignSlugs, isBranchSlug, slugify } from '../src/bo/branch-slug.js';
import { parsePublicConfig } from '../src/bo/public-config.js';

await test('a name becomes the address: letters and digits, hyphens between, no accents', () => {
  assert.equal(slugify('Lalmatia'), 'lalmatia');
  assert.equal(slugify('  Gulshan 2 Circle  '), 'gulshan-2-circle');
  assert.equal(slugify('Café Road #5'), 'cafe-road-5');
  assert.equal(slugify('লালমাটিয়া'), '', 'Bengali has no letters an address can use');
  assert.equal(slugify('---'), '');
  assert.ok(slugify('a'.repeat(100)).length <= 48);
});

await test('only lowercase words joined by single hyphens are addresses', () => {
  for (const good of ['lalmatia', 'a1', 'gulshan-2', 'branch-3'])
    assert.equal(isBranchSlug(good), true, good);
  for (const bad of ['', 'Lalmatia', 'a b', 'a--b', '-a', 'a-', 'a/b', 'a.b', 'লাল', 5, null])
    assert.equal(isBranchSlug(bad), false, String(bad));
});

await test('every branch ends with an address of its own: kept, from the English name, or by its place', () => {
  const result = assignSlugs([
    { slug: 'main-office', name: { en: 'Head office' } },
    { name: { en: 'Gulshan' } },
    { name: { bn: 'কাকরাইল' } },
    { name: { en: 'Gulshan' } },
    { slug: 'main-office', name: { en: 'Second main' } },
    { slug: 'Bad Slug', name: { en: 'Banani' } },
  ]);
  assert.deepEqual(
    result.map((b) => b.slug),
    ['main-office', 'gulshan', 'branch-3', 'gulshan-2', 'second-main', 'banani'],
  );
  assert.equal(new Set(result.map((b) => b.slug)).size, result.length);
});

await test('a typed address is never replaced by a later name, and the result does not depend on how often it runs', () => {
  const once = assignSlugs([{ name: { en: 'Gulshan' } }, { name: { en: 'Gulshan' } }]);
  const twice = assignSlugs(once.map((b) => ({ ...b, name: { en: 'Renamed' } })));
  assert.deepEqual(
    twice.map((b) => b.slug),
    ['gulshan', 'gulshan-2'],
  );
});

await test('the public config gives a branch stored without an address one, and keeps a stored one', () => {
  const config = parsePublicConfig({
    branches: [
      { name: { en: 'Lalmatia' } },
      { slug: 'kakrail-office', name: { en: 'Kakrail' } },
      { slug: 'NOT valid', name: { en: 'Gulshan' } },
    ],
  });
  assert.deepEqual(
    config.branches.map((b) => b.slug),
    ['lalmatia', 'kakrail-office', 'gulshan'],
  );
});
