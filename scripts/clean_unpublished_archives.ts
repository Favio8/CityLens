/**
 * 清理未发布档案（P1-11维护通道）：
 *   npm run archives:clean-unpublished            # dry-run，只打印将删除的清单
 *   npm run archives:clean-unpublished -- --apply # 执行删除
 *
 * 只删除 status='unpublished' 且非预置的档案（含模块行）；
 * 预置档案与已发布（complete/partial）档案绝不受影响。
 */
import { openDb } from '../server/db';
import { ArchiveRepo } from '../server/db/archiveRepo';

function main(): void {
  const apply = process.argv.includes('--apply');
  const db = openDb();
  const repo = new ArchiveRepo(db);
  const before = repo.countArchives();

  if (!apply) {
    // dry-run：只读统计，不写库
    const rows = db
      .prepare("SELECT city_id FROM city_archives WHERE status = 'unpublished' AND is_preset = 0")
      .all() as Array<{ city_id: string }>;
    console.log(
      `[clean] dry-run：${rows.length} 份未发布档案待清理（${rows.map((row) => row.city_id).join(', ') || '无'}）`,
    );
    console.log('[clean] 确认后加 --apply 执行；预置与已发布档案不受影响。');
    return;
  }

  const removed = repo.deleteUnpublished();
  console.log(`[clean] 已删除 ${removed.length} 份未发布档案：${removed.join(', ') || '无'}`);
  console.log(`[clean] 档案总数 ${before} → ${repo.countArchives()}`);
}

main();
