import test from 'node:test';
import assert from 'node:assert/strict';

import { formatTokenCount } from '../src/lib/format.ts';

test('formatTokenCount abbreviates million-scale token counts', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(999_999), '999,999');
  assert.equal(formatTokenCount(1_000_000), '1M');
  assert.equal(formatTokenCount(3_701_839), '3.7M');
});
