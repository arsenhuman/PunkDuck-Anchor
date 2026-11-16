import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectForDeletion } from '../src/retention.js';

const now = new Date('2026-11-16T00:00:00Z');
const daysAgo = (n) => new Date(now.getTime() - n * 86400000).toISOString();
// ids f0 (newest) .. f9 (oldest), one per day
const files = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, createdTime: daysAgo(i) })).reverse();
const ids = (xs) => xs.map((f) => f.id).sort();

test('no rules -> nothing deleted', () => {
  assert.deepEqual(selectForDeletion(files, {}, now), []);
});

test('keepLast only', () => {
  assert.deepEqual(ids(selectForDeletion(files, { keepLast: 3 }, now)), ['f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9']);
});

test('keepDays only', () => {
  // f0..f4 are younger than or exactly 4 days
  assert.deepEqual(ids(selectForDeletion(files, { keepDays: 4 }, now)), ['f5', 'f6', 'f7', 'f8', 'f9']);
});

test('both rules: kept if ANY rule keeps it', () => {
  assert.deepEqual(ids(selectForDeletion(files, { keepLast: 2, keepDays: 5 }, now)), ['f6', 'f7', 'f8', 'f9']);
  assert.deepEqual(ids(selectForDeletion(files, { keepLast: 8, keepDays: 1 }, now)), ['f8', 'f9']);
});

test('newest is never deleted even if older than keepDays', () => {
  const old = [{ id: 'a', createdTime: daysAgo(100) }, { id: 'b', createdTime: daysAgo(200) }];
  assert.deepEqual(ids(selectForDeletion(old, { keepDays: 7 }, now)), ['b']);
});
