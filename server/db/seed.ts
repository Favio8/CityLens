import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '../config';
import { openDb } from './index';

interface DictionaryFile {
  generatedAt: string;
  stats: { cities: number; aliases: number };
  cities: Array<{
    cityId: string;
    standardName: string;
    province: string;
    adminLevel: string;
    countryCode: string;
    pinyin: string;
    englishName: string;
    center: [number, number];
    summary: string;
    hotRank: number | null;
    aliases: Array<{
      key: string;
      display: string;
      matchType: string;
      hint?: string;
    }>;
  }>;
}

async function main(): Promise<void> {
  const dictPath = resolve(config.dataDir, 'city_dictionary.json');
  let dict: DictionaryFile;
  try {
    dict = JSON.parse(await readFile(dictPath, 'utf8')) as DictionaryFile;
  } catch (error) {
    console.error(`[seed] 无法读取词典 ${dictPath}：${(error as Error).message}`);
    console.error('[seed] 请先运行 npm run data:dictionary');
    process.exit(1);
  }

  const db = openDb();
  const insertCity = db.prepare(`
    INSERT INTO cities (city_id, standard_name, province, admin_level, country_code, pinyin,
                        english_name, center_lng, center_lat, summary, hot_rank)
    VALUES (@cityId, @standardName, @province, @adminLevel, @countryCode, @pinyin,
            @englishName, @lng, @lat, @summary, @hotRank)
    ON CONFLICT(city_id) DO UPDATE SET
      standard_name = excluded.standard_name,
      province = excluded.province,
      admin_level = excluded.admin_level,
      country_code = excluded.country_code,
      pinyin = excluded.pinyin,
      english_name = excluded.english_name,
      center_lng = excluded.center_lng,
      center_lat = excluded.center_lat,
      summary = excluded.summary,
      hot_rank = excluded.hot_rank
  `);
  const insertAlias = db.prepare(`
    INSERT OR IGNORE INTO city_aliases (alias_key, display_alias, city_id, match_type, hint)
    VALUES (@key, @display, @cityId, @matchType, @hint)
  `);

  const run = db.transaction(() => {
    db.prepare('DELETE FROM city_aliases').run();
    const incoming = dict.cities.map((c) => c.cityId);
    const placeholders = incoming.map(() => '?').join(',');
    // 清理词典中已移除、且没有档案/任务的僵尸城市，避免脏数据累积
    db.prepare(
      `DELETE FROM cities
       WHERE city_id NOT IN (${placeholders})
         AND city_id NOT IN (SELECT city_id FROM city_archives)
         AND city_id NOT IN (SELECT city_id FROM generation_jobs)`,
    ).run(...incoming);
    for (const city of dict.cities) {
      insertCity.run({
        cityId: city.cityId,
        standardName: city.standardName,
        province: city.province,
        adminLevel: city.adminLevel,
        countryCode: city.countryCode,
        pinyin: city.pinyin,
        englishName: city.englishName,
        lng: city.center[0],
        lat: city.center[1],
        summary: city.summary,
        hotRank: city.hotRank,
      });
      for (const alias of city.aliases) {
        insertAlias.run({
          key: alias.key,
          display: alias.display,
          cityId: city.cityId,
          matchType: alias.matchType,
          hint: alias.hint ?? null,
        });
      }
    }
  });
  run();

  const cityCount = (db.prepare('SELECT COUNT(*) AS n FROM cities').get() as { n: number }).n;
  const aliasCount = (db.prepare('SELECT COUNT(*) AS n FROM city_aliases').get() as { n: number }).n;
  const archiveCount = (db.prepare('SELECT COUNT(*) AS n FROM city_archives').get() as { n: number }).n;
  console.log(
    `[seed] 完成：词典生成于 ${dict.generatedAt}；城市 ${cityCount}，别名 ${aliasCount}，档案 ${archiveCount}`,
  );
  if (dict.stats.cities !== cityCount) {
    console.warn(`[seed] 注意：词典声明 ${dict.stats.cities} 座，库内 ${cityCount} 座`);
  }
  db.close();
}

main().catch((error) => {
  console.error('[seed] 失败：', error);
  process.exit(1);
});
