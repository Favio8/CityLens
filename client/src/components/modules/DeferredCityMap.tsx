/**
 * 视口内再加载地图：地图依赖 MapLibre（约 1.1MB）且会创建 WebGL 上下文。
 * 首屏一次性挂载 4–5 张地图会推高 TBT，并可能触发 WebGL 上下文上限；
 * 这里用 IntersectionObserver 在接近视口时才挂载，占位高度与地图一致，避免版式位移。
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { CityMapProps } from './CityMap';

const CityMap = lazy(() =>
  import('./CityMap').then((module) => ({ default: module.CityMap })),
);

export function DeferredCityMap({ heightClass = 'h-[280px] md:h-[420px]', ...props }: CityMapProps) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const node = holderRef.current;
    if (!node || active) return;
    if (typeof IntersectionObserver === 'undefined') {
      setActive(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setActive(true);
          observer.disconnect();
        }
      },
      { rootMargin: '800px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [active]);

  return (
    <div ref={holderRef}>
      {active ? (
        <Suspense fallback={<MapPlaceholder heightClass={heightClass} label="地图加载中" />}>
          <CityMap {...props} heightClass={heightClass} />
        </Suspense>
      ) : (
        <MapPlaceholder heightClass={heightClass} label="地图进入视口后加载" />
      )}
    </div>
  );
}

function MapPlaceholder({ heightClass, label }: { heightClass: string; label: string }) {
  return (
    <div className={`surface-card w-full animate-pulse rounded-md ${heightClass}`} aria-busy="true">
      <span className="sr-only">{label}</span>
    </div>
  );
}
