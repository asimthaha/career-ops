// tests/pii-workspace.test.mjs — tests for pii-workspace tokenization tool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  scrub,
  rehydrate,
  atomicWriteFileSync,
  loadTokenMap,
  saveTokenMap,
} from '../pii-workspace.mjs';

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-ws-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('scrub allocates YAML-safe tokens and reuses only on exact case match', () => {
  const mockGuard = {
    textValues: new Set(['jordan placeholder', 'project nightingale']),
  };
  const map = {};

  const text = 'Candidate Jordan Placeholder worked on Project Nightingale. Another Jordan Placeholder.';
  const scrubbed = scrub(text, mockGuard, map);

  assert.match(scrubbed, /PRIVACY_VALUE_1/);
  assert.match(scrubbed, /PRIVACY_VALUE_2/);
  // Unquoted scalar validity: no braces, colons, or quotes
  assert.doesNotMatch(scrubbed, /[{}[\]:"]/);

  // Exact spelling match reuses token
  assert.equal(scrubbed.match(/PRIVACY_VALUE_1/g).length, 2);

  // Case difference allocates separate token
  const differentCase = 'Small jordan placeholder was here.';
  const scrubbedDiff = scrub(differentCase, mockGuard, map);
  assert.match(scrubbedDiff, /PRIVACY_VALUE_3/);
  assert.equal(map['PRIVACY_VALUE_3'], 'jordan placeholder');
});

test('rehydrate performs single-pass lookup avoiding prefix corruption for overlapping tokens', () => {
  const map = {
    PRIVACY_VALUE_1: 'Alice',
    PRIVACY_VALUE_10: 'Bob',
    PRIVACY_VALUE_100: 'Charlie',
  };

  // Text contains PRIVACY_VALUE_10 and PRIVACY_VALUE_100
  const input = 'First: PRIVACY_VALUE_1, Tenth: PRIVACY_VALUE_10, Hundredth: PRIVACY_VALUE_100.';
  const restored = rehydrate(input, map);

  assert.equal(restored, 'First: Alice, Tenth: Bob, Hundredth: Charlie.');
  // Must not produce corrupted forms like "Alice0"
  assert.doesNotMatch(restored, /Alice0/);
});

test('rehydrate handles legacy tokens in descending length order', () => {
  const map = {
    SHORT: 'short_val',
    SHORT_EXTRA: 'long_val',
  };

  const input = 'Tokens: SHORT_EXTRA and SHORT.';
  const restored = rehydrate(input, map);

  assert.equal(restored, 'Tokens: long_val and short_val.');
  assert.doesNotMatch(restored, /short_val_EXTRA/);
});

test('rehydrate matches numeric and legacy tokens in a single pass without re-processing inserted values', () => {
  const map = {
    TOKEN_A: 'value with TOKEN_B inside',
    TOKEN_B: 'replaced_val',
    PRIVACY_VALUE_1: 'value with PRIVACY_VALUE_2 inside',
    PRIVACY_VALUE_2: 'another_val',
  };

  const input = 'Test: TOKEN_A and PRIVACY_VALUE_1.';
  const restored = rehydrate(input, map);

  assert.equal(restored, 'Test: value with TOKEN_B inside and value with PRIVACY_VALUE_2 inside.');
  assert.doesNotMatch(restored, /replaced_val/);
  assert.doesNotMatch(restored, /another_val/);
});

test('atomicWriteFileSync writes atomically and preserves file mode', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'test.txt');
    fs.writeFileSync(target, 'initial', { mode: 0o644 });
    const expectedMode = fs.statSync(target).mode & 0o777;

    atomicWriteFileSync(target, 'updated', 'utf8');
    assert.equal(fs.readFileSync(target, 'utf8'), 'updated');

    // On non-Windows platforms verify mode preservation
    if (process.platform !== 'win32') {
      const mode = fs.statSync(target).mode & 0o777;
      assert.equal(mode, expectedMode);
    }
  });
});

test('atomicWriteFileSync cleans up temporary file on successful write', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'test.txt');
    atomicWriteFileSync(target, 'hello', 'utf8');
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello');
    const tempFiles = fs.readdirSync(dir).filter((f) => f.startsWith('.tmp-'));
    assert.equal(tempFiles.length, 0, 'no temporary files left after success');
  });
});

test('atomicWriteFileSync cleans up temporary file if write fails', () => {
  withTempDir((dir) => {
    // Pointing target to an existing directory forces renameSync to fail (EISDIR / EPERM)
    const target = path.join(dir, 'dir_as_target');
    fs.mkdirSync(target);

    assert.throws(() => atomicWriteFileSync(target, 'hello', 'utf8'));
    const tempFiles = fs.readdirSync(dir).filter((f) => f.startsWith('.tmp-'));
    assert.equal(tempFiles.length, 0, 'no temporary files left after failed write');
  });
});
