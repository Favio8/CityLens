/** 卷目导航：桌面右侧竖排，移动端悬浮卷标。 */
import { useEffect, useState } from 'react';

export const MODULE_SECTIONS = [
  { id: 'identity', index: '01', label: '城市名片' },
  { id: 'chronicle', index: '02', label: '前世今生' },
  { id: 'landmarks', index: '03', label: '景点地图' },
  { id: 'relics', index: '04', label: '文物重器' },
  { id: 'figures', index: '05', label: '名人故里' },
  { id: 'poetics', index: '06', label: '诗词文脉' },
  { id: 'localSoul', index: '07', label: '城市性格' },
  { id: 'dataPulse', index: '08', label: '数据脉搏' },
] as const;

export function ScrollNav() {
  const [active, setActive] = useState<string>('identity');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActive(visible.target.id);
      },
      { rootMargin: '-38% 0px -52% 0px', threshold: 0 },
    );
    for (const section of MODULE_SECTIONS) {
      const element = document.getElementById(section.id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <nav
        className="fixed right-5 top-1/2 z-30 hidden -translate-y-1/2 flex-col items-end gap-1 2xl:flex"
        aria-label="卷目导航"
      >
        {MODULE_SECTIONS.map((section, position) => {
          const isActive = active === section.id;
          const passed = MODULE_SECTIONS.findIndex((item) => item.id === active) > position;
          return (
            <a
              key={section.id}
              href={`#${section.id}`}
              className="group flex items-center gap-3 py-1.5"
              aria-current={isActive ? 'true' : undefined}
              aria-label={`${section.index} ${section.label}`}
            >
              <span
                className={`font-serif text-[11px] tracking-[0.18em] transition-all duration-300 ${
                  isActive
                    ? 'text-[var(--city-primary)] opacity-100'
                    : 'text-[var(--text-secondary)] opacity-0 group-hover:opacity-100'
                }`}
              >
                {section.label}
              </span>
              <span
                className={`block rounded-full transition-all duration-300 ${
                  isActive
                    ? 'h-1.5 w-1.5 bg-[var(--city-primary)]'
                    : passed
                      ? 'h-1 w-1 bg-[var(--border-strong)]'
                      : 'h-1 w-1 bg-[var(--border-subtle)]'
                }`}
                aria-hidden
              />
            </a>
          );
        })}
      </nav>

      <div className="fixed bottom-5 right-5 z-30 2xl:hidden">
        {open ? (
          <nav
            className="surface-card mb-2 w-44 rounded-md p-3"
            aria-label="卷目导航"
            style={{ boxShadow: 'var(--shadow-lift)' }}
          >
            {MODULE_SECTIONS.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                onClick={() => setOpen(false)}
                className="flex items-center justify-between px-2 py-2 text-xs tracking-[0.12em]"
              >
                <span className="font-serif">{section.label}</span>
                <span className="mono text-[10px] text-[var(--text-secondary)]">{section.index}</span>
              </a>
            ))}
          </nav>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="ml-auto grid h-12 w-12 place-items-center rounded-full border text-sm shadow-lg"
          style={{
            borderColor: 'var(--city-primary)',
            background: 'var(--bg-elevated)',
            color: 'var(--city-primary)',
          }}
          aria-expanded={open}
          aria-label={open ? '收起卷目' : '展开卷目'}
        >
          <span className="font-serif">{open ? '×' : '卷'}</span>
        </button>
      </div>
    </>
  );
}
