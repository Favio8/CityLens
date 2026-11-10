/**
 * 通用城市地图（PRD 4.5 / 3.3 / AC-05 / AC-06 / AC-07）。
 * - 有天地图 Key：瓦片底图 + 注记层；无 Key：行政区轮廓 + 宣纸底，绝不伪造底图；
 * - 坐标为 WGS84，全链路不做 GCJ-02 转换；
 * - 通过 scope 区分 landmarks / relics / figures / poetics 四个地图实例的联动事件；
 * - Marker 点击回传 onSelect，由父级滚动并高亮对应卡片。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AttributionControl,
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
  type MapOptions,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { GeoJSON } from 'geojson';
import type { Coord } from '@citylens/shared/schema';
import { getMapConfig, type MapConfig } from '../../lib/api';
import { MAP_FOCUS_EVENT, type MapFocusDetail } from '../../lib/mapFocus';
import { useReducedMotion } from '../../hooks/useReducedMotion';

type MapStyle = Exclude<MapOptions['style'], string | undefined>;

export interface CityMapPoint {
  id: string;
  name: string;
  coordinates: Coord;
  kindLabel?: string;
}

interface CityMapProps {
  cityId: string;
  cityName: string;
  center: Coord;
  points: CityMapPoint[];
  scope: MapScope;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  heightClass?: string;
  ariaLabel?: string;
  /** 是否在点位变化时自动缩放到包围盒，默认 true。 */
  fitPoints?: boolean;
}

export type MapScope = 'landmarks' | 'relics' | 'figures' | 'poetics';

function tiandituStyle(key: string): MapStyle {
  const subdomains = Array.from({ length: 8 }, (_, index) => index);
  const vec = subdomains.map(
    (sub) =>
      `https://t${sub}.tianditu.gov.cn/vec_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vec&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${key}`,
  );
  const cva = subdomains.map(
    (sub) =>
      `https://t${sub}.tianditu.gov.cn/cva_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cva&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${key}`,
  );
  return {
    version: 8,
    sources: {
      'tianditu-vec': {
        type: 'raster',
        tiles: vec,
        tileSize: 256,
        attribution: '© 天地图',
        maxzoom: 18,
      },
      'tianditu-cva': {
        type: 'raster',
        tiles: cva,
        tileSize: 256,
        maxzoom: 18,
      },
    },
    layers: [
      { id: 'tianditu-vec', type: 'raster', source: 'tianditu-vec', minzoom: 0, maxzoom: 19 },
      { id: 'tianditu-cva', type: 'raster', source: 'tianditu-cva', minzoom: 0, maxzoom: 19 },
    ],
  };
}

function emptyStyle(): MapStyle {
  const dark = document.documentElement.dataset.theme === 'dark';
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: 'paper-background',
        type: 'background',
        paint: { 'background-color': dark ? '#15171b' : '#f2ede2' },
      },
    ],
  };
}

export function CityMap({
  cityId,
  cityName,
  center,
  points,
  scope,
  selectedId = null,
  onSelect,
  heightClass = 'h-[280px] md:h-[420px]',
  ariaLabel,
  fitPoints = true,
}: CityMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const markersRef = useRef(new Map<string, { marker: Marker; element: HTMLElement }>());
  const [config, setConfig] = useState<MapConfig | null>(null);
  const [failed, setFailed] = useState(false);
  const reduced = useReducedMotion();

  const pointsKey = useMemo(() => points.map((point) => point.id).join('|'), [points]);

  useEffect(() => {
    const controller = new AbortController();
    void getMapConfig(controller.signal)
      .then(setConfig)
      .catch(() => {
        /* 卸载或网络失败时保持无底图模式 */
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!config || !containerRef.current) return;
    const container = containerRef.current;

    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container,
        style: config.enabled && config.key ? tiandituStyle(config.key) : emptyStyle(),
        center,
        zoom: 10.5,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        maxZoom: 17,
        cooperativeGestures: window.innerWidth < 768,
      });
    } catch {
      setFailed(true);
      return;
    }
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(
      new AttributionControl({
        compact: true,
        customAttribution: config.enabled ? '© 天地图' : '无底图模式',
      }),
    );

    const popup = new Popup({ offset: 18, closeButton: false, className: 'citylens-popup' });
    popupRef.current = popup;

    const showPopup = (lng: number, lat: number, label: string): void => {
      const node = document.createElement('div');
      node.className = 'font-serif text-xs tracking-[0.08em]';
      node.textContent = label;
      popup.setLngLat([lng, lat]).setDOMContent(node).addTo(map);
    };

    const onError = (): void => setFailed(true);
    map.on('error', onError);

    map.on('load', () => {
      // 行政区轮廓（仅预置城市有构建期下载的真实 GeoJSON）
      void fetch(`/geo/${cityId}.json`)
        .then((response) => (response.ok ? response.json() : null))
        .then((geojson: GeoJSON | null) => {
          if (!geojson || !mapRef.current) return;
          map.addSource('boundary', { type: 'geojson', data: geojson });
          map.addLayer({
            id: 'boundary-fill',
            type: 'fill',
            source: 'boundary',
            paint: { 'fill-color': '#8C3F2B', 'fill-opacity': 0.05 },
          });
          map.addLayer({
            id: 'boundary-line',
            type: 'line',
            source: 'boundary',
            paint: { 'line-color': '#8C3F2B', 'line-width': 1.2, 'line-opacity': 0.5 },
          });
        })
        .catch(() => {
          /* 无轮廓文件时保持无底图模式 */
        });
    });

    const onFocus = (event: Event): void => {
      const detail = (event as CustomEvent<MapFocusDetail>).detail;
      if (!detail || (detail.scope ?? 'landmarks') !== scope) return;
      if (detail.reset) {
        map.flyTo({
          center,
          zoom: 10.5,
          duration: reduced ? 0 : 900,
          essential: true,
        });
        popup.remove();
        return;
      }
      if (typeof detail.lng !== 'number' || typeof detail.lat !== 'number') return;
      map.flyTo({
        center: [detail.lng, detail.lat],
        zoom: 14,
        duration: reduced ? 0 : 1200,
        essential: true,
      });
      showPopup(detail.lng, detail.lat, detail.label ?? cityName);
    };
    window.addEventListener(MAP_FOCUS_EVENT, onFocus);

    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(container);

    return () => {
      window.removeEventListener(MAP_FOCUS_EVENT, onFocus);
      resizeObserver.disconnect();
      popup.remove();
      map.off('error', onError);
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
    };
  }, [config, center, cityId, cityName, reduced, scope]);

  // 点位变化时重建 marker，并按包围盒缩放到合适视野
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const rebuild = (): void => {
      for (const item of markersRef.current.values()) item.marker.remove();
      markersRef.current.clear();

      for (const point of points) {
        const [lng, lat] = point.coordinates;
        const element = document.createElement('button');
        element.type = 'button';
        element.className = 'citylens-marker';
        if (point.id === selectedId) element.classList.add('citylens-marker--active');
        element.setAttribute('aria-label', `${point.name}${point.kindLabel ? `，${point.kindLabel}` : ''}`);
        const dot = document.createElement('span');
        dot.className = 'citylens-marker__dot';
        if (point.kindLabel === '秘境') dot.classList.add('citylens-marker__dot--gem');
        const label = document.createElement('span');
        label.className = 'citylens-marker__label';
        label.textContent = point.name;
        element.append(dot, label);
        element.addEventListener('click', () => {
          onSelect?.(point.id);
          map.flyTo({
            center: [lng, lat],
            zoom: 14,
            duration: reduced ? 0 : 900,
            essential: true,
          });
          const node = document.createElement('div');
          node.className = 'font-serif text-xs tracking-[0.08em]';
          node.textContent = point.kindLabel ? `${point.name} · ${point.kindLabel}` : point.name;
          popupRef.current?.setLngLat([lng, lat]).setDOMContent(node).addTo(map);
        });
        const marker = new Marker({ element, anchor: 'bottom' }).setLngLat([lng, lat]).addTo(map);
        markersRef.current.set(point.id, { marker, element });
      }

      if (fitPoints && points.length > 0) {
        const bounds = new LngLatBounds();
        for (const point of points) bounds.extend(point.coordinates);
        if (!bounds.isEmpty()) {
          map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: reduced ? 0 : 700 });
        }
      }
    };

    if (map.loaded()) rebuild();
    else map.once('load', rebuild);

    return () => {
      for (const item of markersRef.current.values()) item.marker.remove();
      markersRef.current.clear();
    };
    // points 内容由 pointsKey 代表；selectedId 单独在下方同步，避免反复重置视野
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointsKey, config, reduced, fitPoints]);

  // 选中态只切换 marker 样式，不移动地图
  useEffect(() => {
    for (const [id, item] of markersRef.current) {
      item.element.classList.toggle('citylens-marker--active', id === selectedId);
    }
  }, [selectedId, pointsKey]);

  return (
    <div className="relative overflow-hidden rounded-md border hairline">
      <div
        ref={containerRef}
        className={`w-full ${heightClass}`}
        role="application"
        aria-label={ariaLabel ?? `${cityName}地图`}
      />
      {failed ? (
        <div className="absolute inset-0 grid place-items-center bg-[var(--bg-canvas)]/90 p-6 text-center">
          <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
            当前环境不支持 WebGL 地图。以下内容仍可阅读，坐标均为 WGS84。
          </p>
        </div>
      ) : null}
      {config && !config.enabled ? (
        <span className="pointer-events-none absolute bottom-3 left-3 hidden rounded-sm bg-[var(--bg-canvas)]/85 px-2 py-1 text-[9px] tracking-[0.18em] text-[var(--text-secondary)] md:block">
          无底图模式 · 配置 TIANDITU_KEY 后显示瓦片
        </span>
      ) : null}
      <span className="pointer-events-none absolute left-3 top-3 rounded-sm bg-[var(--bg-canvas)]/85 px-2 py-1 text-[9px] tracking-[0.18em] text-[var(--text-secondary)] md:hidden">
        双指移动地图 · 单指滑动页面
      </span>
    </div>
  );
}
