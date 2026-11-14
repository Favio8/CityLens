/**
 * npm run fact-check —— 为产品负责人生成逐条事实抽查材料（只读）。
 *
 * 从本地数据库档案中抽取：每城最多 5 个景点、5 位人物、5 首诗词，
 * 逐条列出来源（档案来源表）与 verification 状态。
 * 绝不写入或修改任何数据；材料仅供人工抽查，不代表已复核。
 */
import { writeFileSync } from 'node:fs';
import { MODULE_NAMES, type ModuleName } from '../shared/schema';
import { ArchiveRepo, type ModuleRecord } from '../server/db/archiveRepo';
import { CityRepo } from '../server/db/cityRepo';
import { openDb } from '../server/db';
import type { SourceRef } from '../shared/schema';

/** 抽取范围：六座预置（内容最全）+ 两座运行期成卷城市。 */
const TARGET_CITIES: Array<{ cityId: string; note: string }> = [
  { cityId: 'CN-610100', note: '预置馆藏（人工整理 + 本地事实）' },
  { cityId: 'CN-110000', note: '预置馆藏（人工整理 + 本地事实）' },
  { cityId: 'CN-330100', note: '预置馆藏（人工整理 + 本地事实）' },
  { cityId: 'CN-510100', note: '预置馆藏（人工整理 + 本地事实）' },
  { cityId: 'CN-320500', note: '预置馆藏（人工整理 + 本地事实）' },
  { cityId: 'CN-410300', note: '预置馆藏（人工整理 + 本地事实）' },
  { cityId: 'CN-410500', note: '运行期生成（LLM 整理 + Wikidata 快照）' },
  { cityId: 'CN-321100', note: '运行期生成（LLM 整理 + Wikidata 快照）' },
];

const MAX_ITEMS = 5;

interface Item {
  title: string;
  detail: string;
  sourceIds: string[];
  verification: string;
}

function str(value: unknown, fallback = '待考'): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function collectIds(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'sourceRefs' && Array.isArray(child)) {
      for (const id of child) if (typeof id === 'string') out.add(id);
    } else {
      collectIds(child, out);
    }
  }
}

function moduleOf(records: ModuleRecord[], name: ModuleName): ModuleRecord | undefined {
  return records.find((record) => record.name === name);
}

function dataArray(record: ModuleRecord | undefined): Record<string, unknown>[] {
  if (!record || !Array.isArray(record.data)) return [];
  return record.data.filter(
    (item): item is Record<string, unknown> => !!item && typeof item === 'object',
  );
}

function landmarkItems(record: ModuleRecord | undefined): Item[] {
  return dataArray(record)
    .slice(0, MAX_ITEMS)
    .map((item) => {
      const ids = new Set<string>();
      collectIds(item, ids);
      const coord = Array.isArray(item.coordinates)
        ? `[${(item.coordinates as number[]).join(', ')}]`
        : '待考';
      return {
        title: str(item.name),
        detail: [
          `类别：${str(item.category)}`,
          `推荐理由：${str(item.reason)}`,
          `最佳季节：${str(item.bestSeason)}`,
          `今日地名：${str(item.placeName)}`,
          `坐标（WGS84）：${coord}（来源：${str(item.coordSource)}）`,
        ].join('；'),
        sourceIds: [...ids],
        verification: str(item.verification),
      };
    });
}

function figureItems(record: ModuleRecord | undefined): Item[] {
  return dataArray(record)
    .slice(0, MAX_ITEMS)
    .map((item) => {
      const ids = new Set<string>();
      collectIds(item, ids);
      const evidence = (item.evidence ?? {}) as { property?: string; value?: string };
      return {
        title: str(item.name),
        detail: [
          `朝代：${str(item.dynasty)}`,
          `生卒：${str(item.birthYear)}—${str(item.deathYear)}`,
          `与本城关联：${str(evidence.property)} = ${str(evidence.value)}`,
          `城之羁绊：${str(item.cityBond)}`,
          `生平高光：${str(item.highlights)}`,
        ].join('；'),
        sourceIds: [...ids],
        verification: str(item.verification),
      };
    });
}

function poemItems(record: ModuleRecord | undefined): Item[] {
  return dataArray(record)
    .slice(0, MAX_ITEMS)
    .map((item) => {
      const ids = new Set<string>();
      collectIds(item, ids);
      const lines = Array.isArray(item.lines) ? (item.lines as string[]) : [];
      return {
        title: `${str(item.title)} · ${str(item.author)}（${str(item.dynasty)}）`,
        detail: [`诗句：${lines.join(' / ') || '待考'}`, `背景：${str(item.background)}`].join(
          '；',
        ),
        sourceIds: [...ids],
        verification: str(item.verification),
      };
    });
}

function renderSourceLine(ids: string[], sources: Map<string, SourceRef>): string {
  if (ids.length === 0) return '来源：未登记（需人工补充）';
  const parts = ids.map((id) => {
    const source = sources.get(id);
    if (!source) return `${id}（档案来源表中缺失）`;
    return `${source.title}${source.url ? ` <${source.url}>` : ''}（检索于 ${source.retrievedAt.slice(0, 10)}）`;
  });
  return `来源：${parts.join('；')}`;
}

function main(): void {
  const args = process.argv.slice(2);
  const outputArg = args.find((arg) => arg.startsWith('--output='));
  const date = new Date().toISOString().slice(0, 10);
  const output = outputArg?.slice('--output='.length) ?? `docs/fact-check-${date}.md`;

  const db = openDb();
  const repo = new ArchiveRepo(db);
  const cityRepo = new CityRepo(db);

  const lines: string[] = [];
  lines.push('# CityLens 读城 · 逐条事实抽查材料（供产品负责人人工复核）');
  lines.push('');
  lines.push(`> 生成时间：${new Date().toISOString()}；数据来源：本地数据库档案（只读导出，未做任何修改）。`);
  lines.push('>');
  lines.push('> **这份材料不是复核结论**。条目由预置人工整理稿、Wikidata 快照或 LLM 依据所列来源整理，');
  lines.push('> `verification` 字段原样列出；请逐条核对原始来源后填写结论。');
  lines.push('');

  let cityCount = 0;
  for (const target of TARGET_CITIES) {
    const city = cityRepo.getCity(target.cityId);
    const archive = repo.getArchive(target.cityId);
    if (!city || !archive) {
      lines.push(`## ${target.cityId}（${target.note}）`);
      lines.push('');
      lines.push('本地无此城档案，跳过。');
      lines.push('');
      continue;
    }
    const records = repo.listModules(target.cityId);
    const sources = new Map(archive.sources.map((source) => [source.id, source]));
    const landmarks = landmarkItems(moduleOf(records, 'landmarks'));
    const figures = figureItems(moduleOf(records, 'figures'));
    const poems = poemItems(moduleOf(records, 'poetics'));
    cityCount += 1;

    lines.push(`## ${city.standardName}（${target.cityId} · ${city.province}）`);
    lines.push('');
    lines.push(`- 档案状态：${archive.status}；数据版本 v${archive.dataVersion}；生成模型：${archive.generator?.model ?? '—'}`);
    lines.push(`- 数据性质：${target.note}`);
    lines.push('');

    const section = (title: string, items: Item[], emptyNote: string): void => {
      lines.push(`### ${title}`);
      lines.push('');
      if (items.length === 0) {
        lines.push(`- ${emptyNote}`);
        lines.push('');
        return;
      }
      items.forEach((item, index) => {
        lines.push(`${index + 1}. **${item.title}**`);
        lines.push(`   - ${item.detail}`);
        lines.push(`   - ${renderSourceLine(item.sourceIds, sources)}`);
        lines.push(`   - verification：\`${item.verification}\``);
      });
      lines.push('');
    };

    section('景点（抽查 5 条）', landmarks, '本城档案暂无景点条目。');
    section('人物（抽查 5 条）', figures, '本城档案暂无人物条目。');
    section('诗词（抽查 5 条）', poems, '本城档案暂无诗词条目。');
  }

  lines.push('## 复核说明');
  lines.push('');
  lines.push('- 坐标均为 WGS84，可用权威地图同名地物比对（预置城市要求偏差 < 1.5km，见 PRD 精度口径）。');
  lines.push('- 「待考」为统一占位符，表示无法核验，**不得**以推测值替换。');
  lines.push('- 运行期生成城市（安阳、镇江）的叙事字段由 LLM 依据所列来源整理，请重点抽查是否出现候选之外的实体。');
  lines.push('- 图片对应关系、许可证与地图来源审校见 FEATURES_AND_VERIFICATION.md 7.2 / 7.4，保持待复核状态。');
  lines.push('');

  writeFileSync(output, lines.join('\n'), 'utf8');
  console.log(
    `[fact-check] 已导出 ${cityCount} 城抽查材料 → ${output}（只读，未修改任何数据）`,
  );
}

main();
