/** 页脚：数据来源声明与项目信息。 */
import { Link } from 'react-router-dom';

export function Footer() {
  return (
    <footer className="border-t hairline">
      <div className="page-shell flex flex-col gap-8 py-12 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span
              className="grid h-8 w-8 place-items-center border font-serif text-sm"
              style={{ borderColor: 'var(--city-primary)', color: 'var(--city-primary)' }}
              aria-hidden
            >
              读
            </span>
            <span className="mono text-[10px] tracking-[0.3em] text-[var(--text-secondary)]">CITYLENS</span>
          </div>
          <p className="mt-4 max-w-md text-xs leading-[1.9] text-[var(--text-secondary)]">
            景点、文物、人物、诗词与坐标均来自构建期产物或可核验的公开来源；无法核验的内容标注「待考」。
            内容由 AI 整合，请以权威资料为准。本页不构成任何消费或出行建议。
          </p>
        </div>
        <div className="flex flex-col gap-2 text-xs text-[var(--text-secondary)] md:items-end">
          <Link to="/" className="ink-link">
            回到卷首
          </Link>
          <Link to="/admin" className="ink-link">
            后台管理
          </Link>
          <span className="mono text-[10px]">WGS84 · 全链路不使用 GCJ-02</span>
          <span className="mono text-[10px]">PRD v1.1 · schema 1.1</span>
        </div>
      </div>
    </footer>
  );
}
