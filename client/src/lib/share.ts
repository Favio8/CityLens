/** 分享链接：统一为公开可复制的城市页地址，不带查询参数。 */
export function buildShareUrl(cityId: string, origin: string = window.location.origin): string {
  return new URL(`/city/${encodeURIComponent(cityId)}`, origin).toString();
}
