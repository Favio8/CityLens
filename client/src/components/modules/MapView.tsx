/**
 * 景点地图（PRD 4.5 / 3.3 / AC-05）。
 * - 有天地图 Key：瓦片底图 + 注记层；无 Key：行政区轮廓 + 宣纸底，绝不伪造底图；
 * - 坐标为 WGS84，全链路不做 GCJ-02 转换；
 * - 景点 marker 与右侧清单双向联动，支持其他模块的定位事件。
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
import type { Landmark } from '@citylens/shared/schema';
import { getMapConfig, type MapConfig } from '../../lib/api';
import { MAP_FOCUS_EVENT, type MapFocusDetail } from '../../lib/mapFocus';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { COORD_SOURCE_LABELS } from '../../lib/labels';
import { SourceBadge } from '../ui/SourceBadge';
import type { SourceRef } from '@citylens/shared/schema';

const CATEGORY_LABELS = { must_visit: '必游', hidden_gem: '秘境' } as const;

type MapStyle = Exclude<MapOptions['style'], string | undefined>;

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

interface MapViewProps {
  cityId: string;
  cityName: string;
  center: [number, number];
  landmarks: Landmark[];
  sources: SourceRef[];
}

export function MapView({ cityId, cityName, center, landmarks, sources }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const [config, setConfig] = useState<MapConfig | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<'all' | 'must_visit' | 'hidden_gem'>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const reduced = useReducedMotion();

  const visible = useMemo(
    () => landmarks.filter((item) => filter === 'all' || item.category === filter),
    [landmarks, filter],
  );

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
          const bounds = new LngLatBounds();
          const walk = (coords: unknown): void => {
            if (!Array.isArray(coords)) return;
            if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
              bounds.extend([coords[0] as number, coords[1] as number]);
              return;
            }
            for (const child of coords) walk(child);
          };
          walk((geojson as { geometry?: { coordinates?: unknown } }).geometry?.coordinates);
          const featureCollection = geojson as {
            features?: Array<{ geometry?: { coordinates?: unknown } }>;
          };
          for (const feature of featureCollection.features ?? []) {
            walk(feature.geometry?.coordinates);
          }
          if (!bounds.isEmpty()) {
            map.fitBounds(bounds, { padding: 44, duration: reduced ? 0 : 900 });
          }
        })
        .catch(() => {
          /* 无轮廓文件时保持无底图模式 */
        });

      map.addSource('landmarks', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [],
        },
      });
      map.addLayer({
        id: 'landmark-halo',
        type: 'circle',
        source: 'landmarks',
        paint: {
          'circle-radius': 14,
          'circle-color': '#8C3F2B',
          'circle-opacity': 0.12,
        },
      });
    });

    const onFocus = (event: Event): void => {
      const detail = (event as CustomEvent<MapFocusDetail>).detail;
      if (!detail || typeof detail.lng !== 'number') return;
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
    };
  }, [config, center, cityId, cityName, reduced]);

  // 根据当前筛选重建 marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const markers: Marker[] = [];

    const attach = (): void => {
      for (const landmark of visible) {
        if (!landmark.coordinates) continue;
        const [lng, lat] = landmark.coordinates;
        const element = document.createElement('button');
        element.type = 'button';
        element.className = 'citylens-marker';
        element.setAttribute('aria-label', `${landmark.name}，${CATEGORY_LABELS[landmark.category]}`);
        const dot = document.createElement('span');
        dot.className = 'citylens-marker__dot';
        if (landmark.category === 'hidden_gem') dot.classList.add('citylens-marker__dot--gem');
        const label = document.createElement('span');
        label.className = 'citylens-marker__label';
        label.textContent = landmark.name;
        element.append(dot, label);
        element.addEventListener('click', () => {
          map.flyTo({
            center: [lng, lat],
            zoom: 14,
            duration: reduced ? 0 : 900,
            essential: true,
          });
          const node = document.createElement('div');
          node.className = 'font-serif text-xs tracking-[0.08em]';
          node.textContent = `${landmark.name} · ${CATEGORY_LABELS[landmark.category]}`;
          popupRef.current?.setLngLat([lng, lat]).setDOMContent(node).addTo(map);
          setSelected(landmark.entityRef);
        });
        const marker = new Marker({ element, anchor: 'bottom' })
          .setLngLat([lng, lat])
          .addTo(map);
        markers.push(marker);
      }

      if (visible.length > 0) {
        const bounds = new LngLatBounds();
        for (const landmark of visible) {
          if (landmark.coordinates) bounds.extend(landmark.coordinates);
        }
        if (!bounds.isEmpty()) {
          map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: reduced ? 0 : 700 });
        }
      }
    };

    if (map.loaded()) attach();
    else map.once('load', attach);

    return () => {
      for (const marker of markers) marker.remove();
    };
  }, [visible, reduced, config]);

  const focusLandmark = (landmark: Landmark): void => {
    if (!landmark.coordinates) return;
    setSelected(landmark.entityRef);
    window.dispatchEvent(
      new CustomEvent<MapFocusDetail>(MAP_FOCUS_EVENT, {
        detail: {
          lng: landmark.coordinates[0],
          lat: landmark.coordinates[1],
          label: landmark.name,
        },
      }),
    );
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {(['all', 'must_visit', 'hidden_gem'] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`border px-3 py-1.5 text-[10px] tracking-[0.16em] transition-colors hairline ${
                filter === key
                  ? 'border-[var(--city-primary)] bg-[var(--city-primary)] text-[var(--bg-canvas)]'
                  : 'hover:border-[var(--city-primary)]'
              }`}
              aria-pressed={filter === key}
            >
              {key === 'all' ? '全部' : key === 'must_visit' ? '必游' : '秘境'}
            </button>
          ))}
        </div>
        <span className="mono text-[10px] tracking-[0.14em] text-[var(--text-secondary)]">
          {config?.enabled ? '天地图 · WGS84' : '无底图模式 · 仅轮廓与已核验坐标'}
        </span>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="relative overflow-hidden rounded-md border hairline">
          <div ref={containerRef} className="h-[320px] w-full md:h-[460px]" role="application" aria-label={`${cityName}景点地图`} />
          {failed ? (
            <div className="absolute inset-0 grid place-items-center bg-[var(--bg-canvas)]/90 p-6 text-center">
              <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
                当前环境不支持 WebGL 地图。以下清单仍可阅读，坐标均为 WGS84。
              </p>
            </div>
          ) : null}
          {!config?.enabled ? (
            <span className="pointer-events-none absolute bottom-3 left-3 rounded-sm bg-[var(--bg-canvas)]/85 px-2 py-1 text-[9px] tracking-[0.18em] text-[var(--text-secondary)]">
              无底图模式 · 配置 TIANDITU_KEY 后显示瓦片
            </span>
          ) : null}
        </div>

        <ul className="max-h-[460px] space-y-2 overflow-y-auto pr-1">
          {visible.map((landmark) => (
            <li
              key={landmark.entityRef}
              className={`rounded-sm border p-3 transition-colors hairline ${
                selected === landmark.entityRef ? 'bg-[var(--city-primary)]/5' : 'hover:bg-[var(--city-primary)]/5'
              }`}
            >
              <button
                type="button"
                onClick={() => focusLandmark(landmark)}
                className="block w-full text-left"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-serif text-sm tracking-[0.08em]">{landmark.name}</span>
                  <span
                    className={`border px-1.5 py-0.5 text-[9px] tracking-[0.14em] ${
                      landmark.category === 'must_visit'
                        ? 'border-[var(--city-primary)] text-[var(--city-primary)]'
                        : 'text-[var(--text-secondary)] hairline'
                    }`}
                  >
                    {CATEGORY_LABELS[landmark.category]}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  {landmark.reason}
                </p>
              </button>
              <div className="mt-2 flex items-center justify-between gap-2 text-[9px] text-[var(--text-secondary)]">
                <span className="mono">
                  {landmark.coordinates
                    ? `${landmark.coordinates[1].toFixed(3)}, ${landmark.coordinates[0].toFixed(3)}`
                    : '坐标待考'}
                </span>
                <span>{COORD_SOURCE_LABELS[landmark.coordSource]}</span>
                <SourceBadge sourceRefs={landmark.sourceRefs} sources={sources} />
              </div>
              {landmark.bestSeason !== '待考' ? (
                <p className="mt-1 text-[9px] text-[var(--text-secondary)]">
                  最佳时节 · {landmark.bestSeason}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
