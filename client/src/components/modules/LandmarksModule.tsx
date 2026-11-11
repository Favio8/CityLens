/** 03 景点地图：地图 + 清单 + 坐标状态说明。 */
import type { Landmark, SourceRef } from '@citylens/shared/schema';
import { MapView } from './MapView';

export function LandmarksModule({
  cityId,
  cityName,
  center,
  data,
  sources,
}: {
  cityId: string;
  cityName: string;
  center: [number, number];
  data: Landmark[];
  sources: SourceRef[];
}) {
  const missing = data.filter((item) => !item.coordinates);

  return (
    <div>
      <p className="mb-5 max-w-3xl text-xs leading-relaxed text-[var(--text-secondary)]">
        必游与秘境分层显示。坐标统一为 WGS84，不使用任何 GCJ-02 偏移；无坐标的条目只进入清单，不在地图上臆测位置。
      </p>
      <MapView cityId={cityId} cityName={cityName} center={center} landmarks={data} sources={sources} />
      {missing.length > 0 ? (
        <p className="mt-4 text-[10px] leading-relaxed text-[var(--text-secondary)]">
          坐标待考：{missing.map((item) => item.name).join('、')}。这些条目未绘制地图点，坐标待补充。
        </p>
      ) : null}
    </div>
  );
}
