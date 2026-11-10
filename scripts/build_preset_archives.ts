/**
 * 构建六座预置城市的档案：本地事实模块 + 人工整理稿 → SQLite。
 * 非预置城市仍走运行期流式生成，本脚本不影响它们。
 *
 * 用法：npm run data:presets（需先 npm run seed）
 */
import { PRESET_CITY_IDS } from '../shared/schema';
import { paletteForCity } from '../shared/cityThemes';
import { ArchiveRepo } from '../server/db/archiveRepo';
import { CityRepo } from '../server/db/cityRepo';
import { openDb } from '../server/db';
import {
  assertPresetBundle,
  buildPresetBundle,
} from '../server/services/presetArchiveBuilder';

async function main(): Promise<void> {
  const db = openDb();
  const cityRepo = new CityRepo(db);
  const archiveRepo = new ArchiveRepo(db);
  const generatedAt = new Date().toISOString();

  let totalModules = 0;
  for (const cityId of PRESET_CITY_IDS) {
    const city = cityRepo.getCity(cityId);
    if (!city) {
      console.error(`[preset] 词典中缺少 ${cityId}，请先运行 npm run seed`);
      process.exitCode = 1;
      continue;
    }
    const aliases = cityRepo
      .listAncientAliases(cityId)
      .filter((alias) => alias !== city.standardName)
      .slice(0, 4);

    const bundle = await buildPresetBundle(city, aliases);
    assertPresetBundle(bundle, cityId);

    // 预置档案整体重建：先清模块，避免旧版本残留。
    db.prepare('DELETE FROM city_modules WHERE city_id = ?').run(cityId);
    archiveRepo.upsertArchive({
      cityId,
      status: 'partial',
      themePalette: paletteForCity(cityId),
      sources: bundle.sources,
      isPreset: true,
      generator: { model: 'preset-assembly', promptVersion: 'preset-v1' },
      generatedAt,
    });
    for (const module of bundle.modules) {
      archiveRepo.saveModule({
        cityId,
        name: module.name,
        status: module.status,
        data: module.data,
        verification: { status: module.verification },
        generatedAt,
      });
    }
    archiveRepo.setMeta(cityId, {
      themePalette: paletteForCity(cityId),
      sources: bundle.sources,
      generator: { model: 'preset-assembly', promptVersion: 'preset-v1' },
      generatedAt,
    });
    archiveRepo.updateStatus(cityId, 'partial', generatedAt);

    totalModules += bundle.modules.length;
    const names = bundle.modules.map((module) => module.name).join(',');
    console.log(
      `[preset] ${cityId} ${city.standardName}：${bundle.modules.length} 卷（${names}）` +
        (bundle.missing.length > 0 ? `；暂缺 ${bundle.missing.join(',')}` : ''),
    );
  }

  console.log(
    `[preset] 完成：${PRESET_CITY_IDS.length} 座城市，共 ${totalModules} 卷；来源 ${new Set(
      (db.prepare('SELECT sources_json FROM city_archives WHERE is_preset = 1').all() as Array<{
        sources_json: string;
      }>).flatMap((row) => (JSON.parse(row.sources_json) as Array<{ id: string }>).map((s) => s.id)),
    ).size} 个`,
  );
  db.close();
}

main().catch((error) => {
  console.error('[preset] 失败：', error);
  process.exit(1);
});
