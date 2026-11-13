import { describe, expect, it } from 'vitest';
import { buildShareUrl } from './share';

describe('buildShareUrl', () => {
  it('拼接城市页地址', () => {
    expect(buildShareUrl('CN-610100', 'https://citylens.example')).toBe(
      'https://citylens.example/city/CN-610100',
    );
  });

  it('兼容带尾斜杠的 origin', () => {
    expect(buildShareUrl('CN-330100', 'https://citylens.example/')).toBe(
      'https://citylens.example/city/CN-330100',
    );
  });
});
