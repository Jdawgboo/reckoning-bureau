import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mixRgb, rgbaPrefix, type RgbColor } from './theme-color.ts';

describe('theme-color', () => {
  it('rgbaPrefix formats an open rgba string', () => {
    const color: RgbColor = { r: 10, g: 20, b: 30 };
    assert.strictEqual(rgbaPrefix(color), 'rgba(10, 20, 30, ');
  });

  it('mixRgb averages channels', () => {
    assert.deepStrictEqual(mixRgb({ r: 0, g: 100, b: 200 }, { r: 100, g: 100, b: 0 }), {
      r: 50,
      g: 100,
      b: 100,
    });
  });
});
