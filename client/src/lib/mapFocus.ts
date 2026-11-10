/** 地图联动：任意模块点击坐标，滚动并定位到景点地图。 */

export interface MapFocusDetail {
  lng: number;
  lat: number;
  label?: string;
}

export const MAP_FOCUS_EVENT = 'citylens:focus-map';

export function focusMap(detail: MapFocusDetail): void {
  window.dispatchEvent(new CustomEvent<MapFocusDetail>(MAP_FOCUS_EVENT, { detail }));
  document.getElementById('landmarks')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
