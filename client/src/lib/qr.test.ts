import { describe, expect, it } from 'vitest';
import { createQrMatrix } from './qr';

describe('createQrMatrix', () => {
  it('生成正方形矩阵并包含左上角定位图案', () => {
    const matrix = createQrMatrix('https://citylens.example/city/CN-610100');
    expect(matrix.length).toBeGreaterThanOrEqual(21);
    expect(matrix.every((row) => row.length === matrix.length)).toBe(true);

    // 定位图案：7×7 深色外框、5×5 浅色内环、3×3 深色中心
    for (let index = 0; index < 7; index += 1) {
      expect(matrix[0]?.[index]).toBe(true);
      expect(matrix[index]?.[0]).toBe(true);
    }
    expect(matrix[1]?.[1]).toBe(false);
    expect(matrix[3]?.[3]).toBe(true);
  });

  it('空内容明确报错', () => {
    expect(() => createQrMatrix('   ')).toThrow('二维码内容不能为空');
  });
});
