/** 模块章节外壳：古籍卷标序号 + 主标题 + 右侧说明。 */
import type { ReactNode } from 'react';
import { Reveal } from './Reveal';

interface SectionShellProps {
  id: string;
  index: string;
  title: string;
  subtitle?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SectionShell({
  id,
  index,
  title,
  subtitle,
  aside,
  children,
  className = '',
}: SectionShellProps) {
  return (
    <section id={id} className={`scroll-mt-28 py-12 md:py-20 ${className}`} aria-labelledby={`${id}-title`}>
      <Reveal>
        <div className="mb-8 flex flex-col gap-4 border-b pb-6 hairline md:mb-12 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="hanzi-index mb-3">
              {index} · {title}
            </div>
            <h2 id={`${id}-title`} className="section-title">
              {title}
            </h2>
            {subtitle ? (
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--text-secondary)]">
                {subtitle}
              </p>
            ) : null}
          </div>
          {aside ? <div className="shrink-0">{aside}</div> : null}
        </div>
      </Reveal>
      {children}
    </section>
  );
}
