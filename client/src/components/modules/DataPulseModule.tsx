/** 08 数据脉搏：GDP、人口与气候图表，标注口径、年份与来源。 */
import { useMemo } from 'react';
import type { DataPulse, SourceRef, ThemePalette } from '@citylens/shared/schema';
import { ensureContrast } from '@citylens/shared/theme';
import type { EChartsCoreOption } from 'echarts/core';
import { EChart } from '../charts/EChart';
import { CANVAS_BACKGROUNDS, DEFAULT_PALETTE, useTheme } from '../../hooks/useDynamicTheme';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { SourceBadge } from '../ui/SourceBadge';
import { PendingTag } from '../ui/Tags';

interface DataPulseModuleProps {
  data: DataPulse;
  sources: SourceRef[];
  palette?: ThemePalette | null;
}

function axisBase(muted: string) {
  return {
    type: 'category' as const,
    axisLine: { lineStyle: { color: muted } },
    axisTick: { show: false },
    axisLabel: { color: muted, fontFamily: 'JetBrains Mono', fontSize: 10 },
    splitLine: { show: false },
    boundaryGap: true,
    data: [] as Array<string | number>,
  };
}

export function DataPulseModule({ data, sources, palette }: DataPulseModuleProps) {
  const { mode } = useTheme();
  const reduced = useReducedMotion();

  const colors = (palette ?? DEFAULT_PALETTE)[mode];
  const background = CANVAS_BACKGROUNDS[mode];
  const primary = ensureContrast(colors.primary, background, 4.5);
  const secondary = ensureContrast(colors.secondary, background, 4.5);
  const accent = ensureContrast(colors.accent, background, 3);
  const muted = mode === 'dark' ? '#8f8a80' : '#8a8478';
  const gridColor = mode === 'dark' ? 'rgba(234,230,223,0.08)' : 'rgba(30,30,30,0.08)';

  const gdpAllNull = data.gdpSeries.every((point) => point.value === null);
  const popAllNull = data.popSeries.every((point) => point.value === null);
  const gdpValid = data.gdpSeries.filter((point) => point.value !== null).length;
  const popValid = data.popSeries.filter((point) => point.value !== null).length;
  const climateAllNull = data.climateMonthly.every(
    (point) => point.tempC === null && point.precipMm === null,
  );

  const gdpOption = useMemo<EChartsCoreOption>(
    () => ({
      animation: !reduced,
      animationDuration: 700,
      animationEasing: 'cubicOut',
      grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'axis',
        backgroundColor: mode === 'dark' ? '#1c1e24' : '#fffdf8',
        borderColor: gridColor,
        textStyle: { color: mode === 'dark' ? '#eae6df' : '#1e1e1e', fontSize: 11 },
        valueFormatter: (value: unknown) =>
          value === null || value === undefined ? '待考' : `${value} ${data.statMeta.gdp.unit}`,
      },
      xAxis: { ...axisBase(muted), data: data.gdpSeries.map((point) => point.year) },
      yAxis: {
        type: 'value',
        axisLabel: { color: muted, fontSize: 10 },
        splitLine: { lineStyle: { color: gridColor } },
        name: data.statMeta.gdp.unit,
        nameTextStyle: { color: muted, fontSize: 10 },
      },
      series: [
        {
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          data: data.gdpSeries.map((point) => point.value),
          lineStyle: { width: 2, color: primary },
          itemStyle: { color: primary },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: `${primary}33` },
                { offset: 1, color: `${primary}00` },
              ],
            },
          },
        },
      ],
    }),
    [data, mode, muted, primary, reduced, gridColor],
  );

  const popOption = useMemo<EChartsCoreOption>(
    () => ({
      animation: !reduced,
      animationDuration: 700,
      animationEasing: 'cubicOut',
      grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'axis',
        backgroundColor: mode === 'dark' ? '#1c1e24' : '#fffdf8',
        borderColor: gridColor,
        textStyle: { color: mode === 'dark' ? '#eae6df' : '#1e1e1e', fontSize: 11 },
        valueFormatter: (value: unknown) =>
          value === null || value === undefined ? '待考' : `${value} ${data.statMeta.pop.unit}`,
      },
      xAxis: { ...axisBase(muted), data: data.popSeries.map((point) => point.year) },
      yAxis: {
        type: 'value',
        axisLabel: { color: muted, fontSize: 10 },
        splitLine: { lineStyle: { color: gridColor } },
        name: data.statMeta.pop.unit,
        nameTextStyle: { color: muted, fontSize: 10 },
        scale: true,
      },
      series: [
        {
          type: 'bar',
          barMaxWidth: 26,
          data: data.popSeries.map((point) => point.value),
          itemStyle: { color: secondary, borderRadius: [2, 2, 0, 0] },
        },
      ],
    }),
    [data, mode, muted, primary, secondary, reduced, gridColor],
  );

  const climateOption = useMemo<EChartsCoreOption>(
    () => ({
      animation: !reduced,
      animationDuration: 700,
      grid: { left: 8, right: 16, top: 34, bottom: 8, containLabel: true },
      tooltip: { trigger: 'axis', backgroundColor: mode === 'dark' ? '#1c1e24' : '#fffdf8', textStyle: { color: mode === 'dark' ? '#eae6df' : '#1e1e1e', fontSize: 11 } },
      legend: {
        top: 0,
        right: 0,
        textStyle: { color: muted, fontSize: 10 },
        itemWidth: 12,
        itemHeight: 8,
      },
      xAxis: {
        ...axisBase(muted),
        data: data.climateMonthly.map((point) => `${point.month}月`),
      },
      yAxis: [
        {
          type: 'value',
          name: '°C',
          axisLabel: { color: muted, fontSize: 10 },
          splitLine: { lineStyle: { color: gridColor } },
          nameTextStyle: { color: muted, fontSize: 10 },
        },
        {
          type: 'value',
          name: 'mm',
          axisLabel: { color: muted, fontSize: 10 },
          splitLine: { show: false },
          nameTextStyle: { color: muted, fontSize: 10 },
        },
      ],
      series: [
        {
          name: '降水量',
          type: 'bar',
          yAxisIndex: 1,
          barMaxWidth: 18,
          data: data.climateMonthly.map((point) => point.precipMm),
          itemStyle: { color: `${accent}66`, borderRadius: [2, 2, 0, 0] },
        },
        {
          name: '均温',
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 5,
          data: data.climateMonthly.map((point) => point.tempC),
          lineStyle: { color: primary, width: 2 },
          itemStyle: { color: primary },
        },
      ],
    }),
    [data, mode, muted, primary, accent, reduced, gridColor],
  );

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title="地区生产总值"
          meta={`${data.statMeta.gdp.unit} · ${data.statMeta.gdp.caliber}`}
          sourceRefs={data.statMeta.gdp.sourceRefs}
          sources={sources}
        >
          {gdpAllNull ? (
            <PendingBlock />
          ) : gdpValid < 3 ? (
            <SeriesList points={data.gdpSeries} unit={data.statMeta.gdp.unit} />
          ) : (
            <EChart option={gdpOption} ariaLabel="地区生产总值趋势图" />
          )}
        </ChartCard>
        <ChartCard
          title="常住人口"
          meta={`${data.statMeta.pop.unit} · ${data.statMeta.pop.caliber}`}
          sourceRefs={data.statMeta.pop.sourceRefs}
          sources={sources}
        >
          {popAllNull ? (
            <PendingBlock />
          ) : popValid < 3 ? (
            <SeriesList points={data.popSeries} unit={data.statMeta.pop.unit} />
          ) : (
            <EChart option={popOption} ariaLabel="常住人口趋势图" />
          )}
        </ChartCard>
      </div>

      <ChartCard
        title="月均气温与降水量"
        meta={`${data.climateMeta.period} · ${data.climateMeta.station}`}
        sourceRefs={data.climateMeta.sourceRefs}
        sources={sources}
      >
        {climateAllNull ? <PendingBlock /> : <EChart option={climateOption} height={280} ariaLabel="月均气温与降水量图" />}
      </ChartCard>

      <p className="text-[10px] leading-relaxed text-[var(--text-secondary)]">
        统计数值以官方口径为准，年份与单位随图标注；缺失值不以估算补齐，一律显示「待考」。
      </p>
    </div>
  );
}

function ChartCard({
  title,
  meta,
  sourceRefs,
  sources,
  children,
}: {
  title: string;
  meta: string;
  sourceRefs: string[];
  sources: SourceRef[];
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border p-5 hairline" style={{ background: 'var(--bg-surface)' }}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="font-serif text-base tracking-[0.12em]">{title}</h3>
          <p className="mt-1 text-[10px] leading-relaxed text-[var(--text-secondary)]">{meta}</p>
        </div>
        <SourceBadge sourceRefs={sourceRefs} sources={sources} />
      </div>
      {children}
    </div>
  );
}

function SeriesList({
  points,
  unit,
}: {
  points: Array<{ year: number; value: number | null }>;
  unit: string;
}) {
  return (
    <div>
      <div className="divide-y border hairline" style={{ borderColor: 'var(--border-subtle)' }}>
        {points.map((point) => (
          <div key={point.year} className="flex items-center justify-between px-3 py-2 text-[11px]">
            <span className="mono text-[var(--text-secondary)]">{point.year}</span>
            <span className="mono">
              {point.value === null ? '待考' : `${point.value} ${unit}`}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-[var(--text-secondary)]">
        有效点不足 3 个，按文字列表展示；缺失年份不做估算。
      </p>
    </div>
  );
}

function PendingBlock() {
  return (
    <div className="grid h-[240px] place-items-center border border-dashed hairline">
      <div className="text-center">
        <PendingTag label="数据待考" />
        <p className="mt-2 text-[10px] text-[var(--text-secondary)]">未取得可核验的统计口径，不做估算。</p>
      </div>
    </div>
  );
}
