/** 地图联动：任意模块点击坐标，定位到对应模块的地图实例。 */

export interface MapFocusDetail {
  lng?: number;
  lat?: number;
  label?: string;
  /** 目标地图：landmarks / relics / figures / poetics，缺省为 landmarks。 */
  scope?: 'landmarks' | 'relics' | 'figures' | 'poetics';
  /** 复位到城市中心（无坐标条目的「全域印记」）。 */
  reset?: boolean;
  /** 是否滚动到目标地图所在章节，默认 true。 */
  scroll?: boolean;
}

export const MAP_FOCUS_EVENT = 'citylens:focus-map';

export function focusMap(detail: MapFocusDetail): void {
  window.dispatchEvent(new CustomEvent<MapFocusDetail>(MAP_FOCUS_EVENT, { detail }));
  if (detail.scroll === false) return;
  document.getElementById(detail.scope ?? 'landmarks')?.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  });
}
