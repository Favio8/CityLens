// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ScrollNav, TOOL_SECTIONS, tocSections } from './ScrollNav';

describe('tocSections', () => {
  it('未成卷时只含八卷，不含行旅工具', () => {
    const sections = tocSections(false);
    expect(sections).toHaveLength(8);
    expect(sections.map((section) => section.id)).not.toContain('daytrip');
  });

  it('成卷后追加一日路线与小测', () => {
    const sections = tocSections(true);
    expect(sections).toHaveLength(10);
    expect(sections.slice(8).map((section) => section.id)).toEqual(
      TOOL_SECTIONS.map((section) => section.id),
    );
  });
});

describe('ScrollNav 渲染', () => {
  it('SSR 渲染卷目锚点（含 aria-label 与 aria-current 结构）', () => {
    const html = renderToString(<ScrollNav showTools />);
    expect(html).toContain('aria-label="卷目导航"');
    expect(html).toContain('href="#identity"');
    expect(html).toContain('href="#dataPulse"');
    expect(html).toContain('href="#daytrip"');
    expect(html).toContain('href="#quiz"');
  });

  it('默认（未传 showTools）不渲染行旅工具入口', () => {
    const html = renderToString(<ScrollNav />);
    expect(html).not.toContain('href="#daytrip"');
    expect(html).toContain('href="#poetics"');
  });
});
