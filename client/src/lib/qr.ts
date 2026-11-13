/**
 * 二维码矩阵：纯同步生成，供 Canvas 海报绘制使用。
 * 不依赖 Canvas / DOM，可在 node 测试中直接验证。
 */
import qrcode from 'qrcode-generator';

export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

export function createQrMatrix(text: string, errorCorrection: QrErrorCorrection = 'M'): boolean[][] {
  const content = text.trim();
  if (!content) throw new Error('二维码内容不能为空');
  const qr = qrcode(0, errorCorrection);
  qr.addData(content);
  qr.make();
  const count = qr.getModuleCount();
  return Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, col) => qr.isDark(row, col)),
  );
}
