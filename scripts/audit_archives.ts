/**
 * npm run archives:audit —— 非预置档案只读校验（不删改任何数据）。
 *
 * 对本地数据库中每一份档案（默认聚焦非预置）做只读检查：
 *  1. 发布状态与模块状态汇总（ok / degraded / failed / missing）；
 *  2. 失败模块及原因（verification.lastAttempt 或 verification 记录）；
 *  3. 已有内容逐卷通过共享 Zod Schema；
 *  4. sourceRefs 是否都在档案来源表中登记（缺来源即报告，不修改）。
 *
 * 输出汇总表 + 明细；退出码 0（这是报告工具，不是门禁）。
 * 参数：--json 输出 JSON；--output=<path> 写入文件；--include-preset 含预置档案。
 */
import { writeFileSync } from 'node:fs';
import { ZodError } from 'zod';
import { MODULE_NAMES, type ModuleName } from '../shared/schema';
import { MODULE_DATA_SCHEMAS } from '../shared/schema';
import { ArchiveRepo, type ModuleRecord } from '../server/db/archiveRepo';
import { CityRepo } from '../server/db/cityRepo';
import { openDb } from '../server/db';

interface ModuleReport {
  name: ModuleName;
  status: string;
  reason: string | null;
  attemptAt: string | null;
  schemaOk: boolean | null;
  schemaIssues: string | null;
  missingSourceRefs: string[];
  hasData: boolean;
}

interface ArchiveReport {
  cityId: string;
  standardName: string;
  province: string;
  isPreset: boolean;
  status: string;
  dataVersion: number;
  generatedAt: string;
  generator: string | null;
  counts: Record<string, number>;
  modules: ModuleReport[];
  failed: ModuleReport[];
}

function collectSourceIds(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSourceIds(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'sourceRefs' && Array.isArray(child)) {
      for (const id of child) if (typeof id === 'string') out.add(id);
    } else {
      collectSourceIds(child, out);
    }
  }
}

function describeZodError(error: ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function attemptReason(record: ModuleRecord): { reason: string | null; attemptAt: string | null } {
  const verification = record.verification as
    | {
        lastAttempt?: { status?: string; code?: string; message?: string; at?: string };
        code?: string;
        message?: string;
        at?: string;
      }
    | null;
  const attempt = verification?.lastAttempt;
  if (attempt?.status === 'failed') {
    return {
      reason: [attempt.code, attempt.message].filter(Boolean).join(' ') || '失败原因未记录',
      attemptAt: attempt.at ?? null,
    };
  }
  if (verification?.code || verification?.message) {
    return {
      reason: [verification.code, verification.message].filter(Boolean).join(' '),
      attemptAt: verification.at ?? null,
    };
  }
  return { reason: null, attemptAt: null };
}

function auditArchive(
  repo: ArchiveRepo,
  cityRepo: CityRepo,
  cityId: string,
): ArchiveReport | null {
  const archive = repo.getArchive(cityId);
  const city = cityRepo.getCity(cityId);
  if (!archive || !city) return null;
  const sourceIds = new Set(archive.sources.map((source) => source.id));
  const modules: ModuleReport[] = [];
  const byName = new Map(repo.listModules(cityId).map((record) => [record.name, record]));
  const counts: Record<string, number> = {};
  for (const name of MODULE_NAMES) {
    const record = byName.get(name);
    const status = record?.status ?? 'missing';
    counts[status] = (counts[status] ?? 0) + 1;
    const { reason, attemptAt } = record ? attemptReason(record) : { reason: null, attemptAt: null };
    const used = new Set<string>();
    if (record?.data !== null && record?.data !== undefined) collectSourceIds(record.data, used);
    const missingSourceRefs = [...used].filter((id) => !sourceIds.has(id));
    let schemaOk: boolean | null = null;
    let schemaIssues: string | null = null;
    if (record && record.data !== null && record.data !== undefined) {
      try {
        MODULE_DATA_SCHEMAS[name].parse(record.data);
        schemaOk = true;
      } catch (error) {
        schemaOk = false;
        schemaIssues =
          error instanceof ZodError ? describeZodError(error) : String(error);
      }
    }
    modules.push({
      name,
      status,
      reason,
      attemptAt,
      schemaOk,
      schemaIssues,
      missingSourceRefs,
      hasData: record?.data !== null && record?.data !== undefined,
    });
  }
  return {
    cityId,
    standardName: city.standardName,
    province: city.province,
    isPreset: archive.isPreset,
    status: archive.status,
    dataVersion: archive.dataVersion,
    generatedAt: archive.generatedAt,
    generator: archive.generator ? `${archive.generator.model}@${archive.generator.promptVersion}` : null,
    counts,
    modules,
    failed: modules.filter((module) => module.status === 'failed' || module.missingSourceRefs.length > 0 || module.schemaOk === false),
  };
}

function renderText(reports: ArchiveReport[]): string {
  const lines: string[] = [];
  lines.push('# 档案只读校验报告（archives:audit）');
  lines.push('');
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push('');
  lines.push('| 城市 | 档案状态 | ok | degraded | failed | missing | 数据版本 | 生成模型 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const report of reports) {
    lines.push(
      `| ${report.standardName}（${report.cityId}）${report.isPreset ? ' ·预置' : ''} | ${report.status} | ${report.counts.ok ?? 0} | ${report.counts.degraded ?? 0} | ${report.counts.failed ?? 0} | ${report.counts.missing ?? 0} | v${report.dataVersion} | ${report.generator ?? '—'} |`,
    );
  }
  lines.push('');
  for (const report of reports) {
    if (report.failed.length === 0) continue;
    lines.push(`## ${report.standardName}（${report.cityId}）`);
    for (const module of report.failed) {
      const details: string[] = [`status=${module.status}`];
      if (module.reason) details.push(`原因：${module.reason}`);
      if (module.attemptAt) details.push(`尝试时间：${module.attemptAt}`);
      if (module.schemaOk === false) details.push(`Schema 未通过：${module.schemaIssues}`);
      if (module.missingSourceRefs.length > 0) {
        details.push(`未登记来源：${module.missingSourceRefs.join(', ')}`);
      }
      lines.push(`- ${module.name}：${details.join('；')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const includePreset = args.includes('--include-preset');
  const outputArg = args.find((arg) => arg.startsWith('--output='));
  const db = openDb();
  const repo = new ArchiveRepo(db);
  const cityRepo = new CityRepo(db);
  const cityIds = cityRepo
    .listCities()
    .map((city) => city.cityId);
  const reports: ArchiveReport[] = [];
  for (const cityId of cityIds) {
    const report = auditArchive(repo, cityRepo, cityId);
    if (!report) continue;
    if (!includePreset && report.isPreset) continue;
    reports.push(report);
  }
  reports.sort((a, b) => a.cityId.localeCompare(b.cityId));

  const totalFailed = reports.reduce((sum, report) => sum + report.failed.length, 0);
  const text = asJson ? JSON.stringify(reports, null, 2) : renderText(reports);
  if (outputArg) {
    writeFileSync(outputArg.slice('--output='.length), text, 'utf8');
    console.log(`[audit] 报告已写入 ${outputArg.slice('--output='.length)}`);
  } else {
    console.log(text);
  }
  console.log(
    `[audit] 共 ${reports.length} 份档案，${totalFailed} 个模块需要关注（只读报告，未做任何修改）`,
  );
}

main();
