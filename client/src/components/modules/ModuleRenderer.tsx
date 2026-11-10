/** 模块分发：每个模块先用自身的 Schema 运行时校验，校验不过即降级隐藏。 */
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
import { DataPulseModule } from './DataPulseModule';
import { FiguresModule } from './FiguresModule';
import { IdentityModule } from './IdentityModule';
import { LandmarksModule } from './LandmarksModule';
import { LocalSoulModule } from './LocalSoulModule';
import { PoeticsModule } from './PoeticsModule';
import { RelicsModule } from './RelicsModule';
import { PendingTag } from '../ui/Tags';

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
        <LandmarksModule
          cityId={cityId}
          cityName={cityName}
          center={center}
          data={parsed}
          sources={sources}
        />
      );
    }
    case 'relics': {
      const parsed = RelicsSchema.parse(data);
      return <RelicsModule data={parsed} sources={sources} />;
    }
    case 'figures': {
      const parsed = FiguresSchema.parse(data);
      return <FiguresModule data={parsed} sources={sources} />;
    }
    case 'poetics': {
      const parsed = PoeticsSchema.parse(data);
      return <PoeticsModule data={parsed} sources={sources} />;
    }
    case 'localSoul': {
      const parsed = LocalSoulSchema.parse(data);
      return <LocalSoulModule data={parsed} sources={sources} />;
    }
    case 'dataPulse': {
      const parsed = DataPulseSchema.parse(data);
      return <DataPulseModule data={parsed} sources={sources} palette={palette} />;
    }
    default:
      return null;
  }
}
