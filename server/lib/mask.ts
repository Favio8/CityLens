/** 密钥展示掩码：只保留前 3 位与后 4 位，绝不返回明文。 */
export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '已配置';
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}
