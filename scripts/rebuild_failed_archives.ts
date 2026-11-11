/**
 * P1-11 一次性维护脚本：重建快照与失败档案。
 * 1) 删除指定城市的 fact_snapshot / recon 缓存，迫使重新联网构建；
 * 2) 对 11 个 unpublished 城市与 4 个快照重建城市逐个 POST generate（force）；
 * 3) 打印每个城市的成卷结果，供人工核对。
 *
 * 用法：node scripts/rebuild_failed_archives.ts（需服务端已在 :8787 运行）
 */
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const DATA_DIR = resolve(here, '../server/data');
const BASE = process.env.CITYLENS_BASE ?? 'http://localhost:8787';

const REBUILD_SNAPSHOTS = ['CN-320100', 'CN-620500', 'CN-321000', 'CN-410500'];
const UNPUBLISHED = [
  'CN-310000', 'CN-440100', 'CN-500000', 'CN-420100', 'CN-430100', 'CN-410100', 'CN-370100',
  'CN-330600', 'CN-350100', 'CN-350500', 'CN-320200', 'CN-320300',
];

async function dropCaches(cityId: string): Promise<void> {
  for (const path of [
    resolve(DATA_DIR, `fact_snapshot/${cityId}.json`),
    resolve(DATA_DIR, `recon/${cityId}.json`),
  ]) {
    try {
      await rm(path);
      console.log(`[rebuild] 已删除缓存 ${path.split('data/')[1]}`);
    } catch {
      /* 不存在则忽略 */
    }
  }
}

async function generate(cityId: string): Promise<void> {
  const startedAt = Date.now();
  const response = await fetch(`${BASE}/api/cities/${cityId}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: true }),
  });
  if (!response.ok || !response.body) {
    console.warn(`[rebuild] ${cityId} 请求失败 HTTP ${response.status}`);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let failed: string[] = [];
  let status = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let idx = buffer.indexOf('\n\n');
    while (idx >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      idx = buffer.indexOf('\n\n');
      const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
      const eventLine = block.split('\n').find((line) => line.startsWith('event:'));
      if (!dataLine || !eventLine) continue;
      try {
        const data = JSON.parse(dataLine.slice(5).trim());
        if (eventLine.slice(6).trim() === 'done') {
          status = data.status;
          failed = data.failedModules ?? [];
        }
      } catch {
        /* 忽略 ping */
      }
    }
  }
  console.log(
    `[rebuild] ${cityId} → ${status || '未知'} failed=${JSON.stringify(failed)} 用时 ${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
}

async function main(): Promise<void> {
  for (const cityId of REBUILD_SNAPSHOTS) await dropCaches(cityId);
  for (const cityId of [...REBUILD_SNAPSHOTS, ...UNPUBLISHED]) {
    await generate(cityId);
  }
  console.log('[rebuild] 全部完成');
}

void main();
