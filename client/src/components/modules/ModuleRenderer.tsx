/** 模块分发：每个模块先用自身的 Schema 运行时校验，校验不过即降级隐藏。 */
import { lazy, Suspense } from 'react';
import {
  ChronicleSchema,
  DataPulseSchema,
  FiguresSchema,
  IdentitySchema,
  LandmarksSchema,
  LocalSoulSchema,
  MODULE_DATA_SCHEMAS,
  PoeticsSchema,
  RelicsSchema,
  type ModuleName,
  type SourceRef,
  type ThemePalette,
} from '@citylens/shared/schema';
import { ChronicleModule } from './ChronicleModule';
import { IdentityModule } from './IdentityModule';
import { LocalSoulModule } from './LocalSoulModule';
import { PendingTag } from '../ui/Tags';

/** 地图与图表依赖较重，进入视口时再加载，避免拖慢首屏。 */
const LandmarksModule = lazy(() =>
  import('./LandmarksModule').then((module) => ({ default: module.LandmarksModule })),
);
const RelicsModule = lazy(() =>
  import('./RelicsModule').then((module) => ({ default: module.RelicsModule })),
);
const FiguresModule = lazy(() =>
  import('./FiguresModule').then((module) => ({ default: module.FiguresModule })),
);
const PoeticsModule = lazy(() =>
  import('./PoeticsModule').then((module) => ({ default: module.PoeticsModule })),
);
const DataPulseModule = lazy(() =>
  import('./DataPulseModule').then((module) => ({ default: module.DataPulseModule })),
);

function HeavyModuleFallback() {
  return (
    <div className="surface-card h-[280px] animate-pulse rounded-md md:h-[420px]" aria-busy="true">
      <span className="sr-only">地图与图表加载中</span>
    </div>
  );
}

interface ModuleRendererProps {
  name: ModuleName;
  data: unknown;
  sources: SourceRef[];
  cityId: string;
  cityName: string;
  center: [number, number];
  palette: ThemePalette | null;
}

function InvalidModule() {
  return (
    <div className="rounded-md border border-dashed p-8 text-center hairline">
      <PendingTag label="此卷数据未通过校验" />
      <p className="mt-3 text-xs leading-relaxed text-[var(--text-secondary)]">
        为避免展示不可信内容，本卷已隐藏。可单独重试；若持续失败，将进入人工复核清单。
      </p>
    </div>
  );
}

export function ModuleRenderer({
  name,
  data,
  sources,
  cityId,
  cityName,
  center,
  palette,
}: ModuleRendererProps) {
  if (!MODULE_DATA_SCHEMAS[name].safeParse(data).success) return <InvalidModule />;

  switch (name) {
    case 'identity': {
      const parsed = IdentitySchema.parse(data);
      return <IdentityModule data={parsed} sources={sources} />;
    }
    case 'chronicle': {
      const parsed = ChronicleSchema.parse(data);
      return <ChronicleModule data={parsed} sources={sources} />;
    }
    case 'landmarks': {
      const parsed = LandmarksSchema.parse(data);
      return (
        <Suspense fallback={<HeavyModuleFallback />}>
          <LandmarksModule
            cityId={cityId}
            cityName={cityName}
            center={center}
            data={parsed}
            sources={sources}
          />
        </Suspense>
      );
    }
    case 'relics': {
      const parsed = RelicsSchema.parse(data);
      return (
        <Suspense fallback={<HeavyModuleFallback />}>
          <RelicsModule
            cityId={cityId}
            cityName={cityName}
            center={center}
            data={parsed}
            sources={sources}
          />
        </Suspense>
      );
    }
    case 'figures': {
      const parsed = FiguresSchema.parse(data);
      return (
        <Suspense fallback={<HeavyModuleFallback />}>
          <FiguresModule
            cityId={cityId}
            cityName={cityName}
            center={center}
            data={parsed}
            sources={sources}
          />
        </Suspense>
      );
    }
    case 'poetics': {
      const parsed = PoeticsSchema.parse(data);
      return (
        <Suspense fallback={<HeavyModuleFallback />}>
          <PoeticsModule
            cityId={cityId}
            cityName={cityName}
            center={center}
            data={parsed}
            sources={sources}
          />
        </Suspense>
      );
    }
    case 'localSoul': {
      const parsed = LocalSoulSchema.parse(data);
      return <LocalSoulModule data={parsed} sources={sources} />;
    }
    case 'dataPulse': {
      const parsed = DataPulseSchema.parse(data);
      return (
        <Suspense fallback={<HeavyModuleFallback />}>
          <DataPulseModule data={parsed} sources={sources} palette={palette} />
        </Suspense>
      );
    }
    default:
      return null;
  }
}
