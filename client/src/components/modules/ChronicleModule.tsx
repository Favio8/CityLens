/**
 * 02 前世今生：朝代滑块 + 古称水印 + 竖向年代轴（AC-05）。
 *
 * 滑块动效约定：
 * - 松手后按临界阻尼弹簧（阻尼比 ζ=1）吸附到最近的朝代节点，并保留松手速度，
 *   快速甩动可越过一个或多个节点；
 * - 拖过首尾边界时使用阻尼位移（rubber band），松手后弹簧回弹到边界；
 * - 拖动中只切换文案与城名，松手后才驱动地图 flyTo，避免地图被高频打断；
 * - 今日遗存参照点来自本城地名库，无坐标节点明确标「待考」，不做推测。
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from 'framer-motion';
import type { ChronicleItem, SourceRef } from '@citylens/shared/schema';
import { focusMap } from '../../lib/mapFocus';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { SourceBadge } from '../ui/SourceBadge';
import { Reveal } from '../ui/Reveal';
import { VerificationTag } from '../ui/Tags';

const THUMB_SIZE = 28;
const THUMB_RADIUS = THUMB_SIZE / 2;
/** 临界阻尼弹簧：damping = 2·√(stiffness·mass) ≈ 2·√380 ≈ 38.99。 */
const SPRING = { type: 'spring' as const, stiffness: 380, damping: 39, mass: 1 };
const OVERSCROLL = 0.34;
const FLICK_PROJECTION_SEC = 0.12;
const VELOCITY_WINDOW_MS = 120;

interface PointerSample {
  x: number;
  t: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function ChronicleModule({ data, sources }: { data: ChronicleItem[]; sources: SourceRef[] }) {
  const [active, setActive] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [edge, setEdge] = useState<-1 | 0 | 1>(0);
  const [metrics, setMetrics] = useState({ max: 0, step: 0 });

  const trackRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(0);
  const metricsRef = useRef(metrics);
  const draggingRef = useRef(false);
  const samplesRef = useRef<PointerSample[]>([]);
  const animationRef = useRef<ReturnType<typeof animate> | null>(null);
  const frameRef = useRef<number | null>(null);

  const x = useMotionValue(0);
  const progressWidth = useTransform(x, (value) => {
    const bounded = clamp(value, 0, metricsRef.current.max || 0);
    return bounded + THUMB_RADIUS;
  });

  const reduced = useReducedMotion();
  const current = data[Math.min(active, data.length - 1)];

  activeRef.current = active;
  metricsRef.current = metrics;

  // 测量轨道可用行程；窗口尺寸变化时重新对齐当前节点
  useEffect(() => {
    const element = trackRef.current;
    if (!element) return;
    const measure = (): void => {
      const max = Math.max(element.clientWidth - THUMB_SIZE, 0);
      const step = data.length > 1 ? max / (data.length - 1) : 0;
      setMetrics({ max, step });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [data.length]);

  useEffect(() => {
    if (metrics.max <= 0 || draggingRef.current) return;
    x.set(activeRef.current * metrics.step);
  }, [metrics.max, metrics.step, x]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      animationRef.current?.stop();
    },
    [],
  );

  const focusEra = (index: number): void => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      const target = data[index];
      if (!target?.centerCoord) return;
      focusMap({
        scope: 'landmarks',
        lng: target.centerCoord[0],
        lat: target.centerCoord[1],
        label: `${target.eraName} · ${target.relicToday}`,
        scroll: false,
      });
    });
  };

  /** 切换朝代并（可选）把地图带到该朝的今日遗存参照点。 */
  const selectEra = (index: number, options: { focusMap?: boolean } = {}): void => {
    const next = clamp(index, 0, data.length - 1);
    activeRef.current = next;
    setActive(next);
    if (options.focusMap) focusEra(next);
  };

  /** 弹簧吸附到指定节点；velocity 为松手瞬间的指针速度（px/s）。 */
  const settleTo = (index: number, velocity = 0, focusMapTarget = true): void => {
    const next = clamp(index, 0, data.length - 1);
    selectEra(next, { focusMap: focusMapTarget });
    const target = next * metricsRef.current.step;
    animationRef.current?.stop();
    if (reduced) {
      x.set(target);
      return;
    }
    animationRef.current = animate(x, target, { ...SPRING, velocity });
  };

  const updateActiveFromPosition = (value: number): void => {
    const step = metricsRef.current.step;
    if (step <= 0) return;
    const index = clamp(Math.round(value / step), 0, data.length - 1);
    if (index !== activeRef.current) selectEra(index);
  };

  const localX = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return clientX - rect.left - THUMB_RADIUS;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const element = trackRef.current;
    if (!element) return;
    animationRef.current?.stop();
    element.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    setDragging(true);
    const start = clamp(localX(event.clientX), 0, metricsRef.current.max);
    x.set(start);
    samplesRef.current = [{ x: start, t: performance.now() }];
    updateActiveFromPosition(start);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return;
    const { max } = metricsRef.current;
    const raw = localX(event.clientX);
    const resisted =
      raw < 0 ? raw * OVERSCROLL : raw > max ? max + (raw - max) * OVERSCROLL : raw;
    x.set(resisted);
    setEdge(raw < -0.5 ? -1 : raw > max + 0.5 ? 1 : 0);

    const now = performance.now();
    samplesRef.current.push({ x: resisted, t: now });
    samplesRef.current = samplesRef.current.filter((sample) => now - sample.t <= VELOCITY_WINDOW_MS);
    updateActiveFromPosition(resisted);
  };

  const releaseVelocity = (): number => {
    // 只统计松手前 120ms 内的位移；停住再松手时速度必须归零。
    const now = performance.now();
    const samples = samplesRef.current.filter((sample) => now - sample.t <= VELOCITY_WINDOW_MS);
    if (samples.length < 2) return 0;
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    const dt = last.t - first.t;
    if (dt <= 0) return 0;
    return clamp(((last.x - first.x) / dt) * 1000, -4000, 4000);
  };

  const endDrag = (): void => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    setEdge(0);

    const { step } = metricsRef.current;
    if (step <= 0) return;
    const velocity = reduced ? 0 : releaseVelocity();
    // 松手速度向前投影一小段时间，决定吸附到哪个朝代（快速甩动可跨节点）。
    const projected = x.get() + velocity * FLICK_PROJECTION_SEC;
    // 拖出边界时 projected 会被夹回首/尾节点，弹簧带着向外速度回弹。
    const index = clamp(Math.round(projected / step), 0, data.length - 1);
    settleTo(index, velocity);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const last = data.length - 1;
    const key = event.key;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return;
    event.preventDefault();
    if (key === 'Home') settleTo(0, 0);
    else if (key === 'End') settleTo(last, 0);
    else if (key === 'ArrowLeft' || key === 'ArrowDown') settleTo(activeRef.current - 1, 0);
    else settleTo(activeRef.current + 1, 0);
  };

  return (
    <div>
      <div
        className="relative mb-8 overflow-hidden rounded-md border p-5 md:p-7 hairline"
        style={{ background: 'var(--bg-surface)' }}
      >
        <AnimatePresence mode="popLayout">
          <motion.span
            key={`${current?.ancientCityName ?? ''}-watermark`}
            aria-hidden
            initial={{ opacity: 0, scale: 1.06, x: 18 }}
            animate={{
              opacity: dragging ? 0.09 : 0.06,
              scale: dragging ? 1.03 : 1,
              x: 0,
            }}
            exit={{ opacity: 0, transition: { duration: 0.18 } }}
            transition={reduced ? { duration: 0 } : { ...SPRING, stiffness: 180, damping: 26 }}
            className="pointer-events-none absolute -right-4 -top-10 select-none font-serif text-[140px] leading-none text-[var(--city-primary)] md:text-[200px]"
          >
            {current?.ancientCityName}
          </motion.span>
        </AnimatePresence>

        <div className="relative">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <p className="text-[10px] tracking-[0.24em] text-[var(--text-secondary)]">
                拖动朝代滑块 · 古今叠压
              </p>
              <div className="mt-2 flex items-baseline gap-3 overflow-hidden">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.p
                    key={`${current?.eraName ?? ''}-title`}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={reduced ? { duration: 0 } : { ...SPRING, stiffness: 300, damping: 30 }}
                    className="font-serif text-2xl tracking-[0.14em] md:text-3xl"
                  >
                    {current?.eraName}
                  </motion.p>
                </AnimatePresence>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={`${current?.ancientCityName ?? ''}-name`}
                    initial={{ opacity: 0, x: 8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -8 }}
                    transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 320, damping: 32 }}
                    className="text-[11px] tracking-[0.16em] text-[var(--city-primary)]"
                  >
                    {current?.ancientCityName}
                  </motion.span>
                </AnimatePresence>
              </div>
            </div>
            <span className="mono text-[10px] tracking-[0.14em] text-[var(--text-secondary)]">
              {current?.periodRange}
            </span>
          </div>

          {/* 自定义滑块：临界阻尼弹簧吸附 + 松手速度 + 边界回弹 */}
          <div
            ref={trackRef}
            role="slider"
            tabIndex={0}
            aria-label="朝代滑块"
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={Math.max(data.length - 1, 0)}
            aria-valuenow={active}
            aria-valuetext={`${current?.eraName ?? ''} ${current?.periodRange ?? ''}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={onKeyDown}
            className="relative mt-7 h-12 cursor-pointer touch-none select-none rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--city-primary)]/40"
          >
            <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-[var(--border-subtle)]" />
            <motion.div
              style={{ width: progressWidth }}
              className="absolute left-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-[var(--city-primary)]"
            />
            {metrics.step > 0
              ? data.map((item, index) => (
                  <span
                    key={`${item.eraName}-${item.startYear}-dot`}
                    aria-hidden
                    className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
                    style={{ left: THUMB_RADIUS + index * metrics.step }}
                  >
                    <motion.span
                      animate={{
                        scale: index === active ? 1.45 : 1,
                        opacity: index === active ? 1 : 0.55,
                      }}
                      transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 32 }}
                      className={`block h-1.5 w-1.5 rounded-full ${
                        index === active
                          ? 'bg-[var(--city-primary)]'
                          : 'border border-[var(--border-strong)] bg-[var(--bg-surface)]'
                      }`}
                    />
                  </span>
                ))
              : null}
            <motion.div
              data-testid="chronicle-thumb"
              style={{ x }}
              animate={{ scale: dragging ? 1.18 : 1 }}
              transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 34 }}
              className={`absolute top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border-2 bg-[var(--bg-canvas)] transition-shadow ${
                dragging
                  ? 'shadow-[0_0_0_8px_color-mix(in_srgb,var(--city-primary)_18%,transparent)]'
                  : 'shadow-[0_0_0_4px_color-mix(in_srgb,var(--city-primary)_12%,transparent)]'
              }`}
              aria-hidden
            >
              <span className="h-2.5 w-2.5 rounded-full bg-[var(--city-primary)]" />
            </motion.div>
            <motion.span
              aria-hidden
              animate={{
                opacity: edge === 0 ? 0 : 0.9,
                scale: edge === 0 ? 0.6 : 1.6,
              }}
              transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 400, damping: 30 }}
              className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-[var(--city-primary)]/30"
              style={{ left: edge === -1 ? 0 : edge === 1 ? metrics.max + THUMB_SIZE : 0 }}
            />
          </div>
          <div className="relative mt-1 h-4">
            {metrics.step > 0
              ? data.map((item, index) => (
                  <button
                    key={`${item.eraName}-${item.startYear}-label`}
                    type="button"
                    onClick={() => settleTo(index, 0)}
                    className={`absolute top-0 -translate-x-1/2 whitespace-nowrap text-[10px] tracking-[0.1em] transition-colors ${
                      index === active
                        ? 'text-[var(--city-primary)]'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                    style={{ left: THUMB_RADIUS + index * metrics.step }}
                    aria-pressed={index === active}
                  >
                    {item.eraName}
                  </button>
                ))
              : null}
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-[1fr_220px]">
            <p className="text-sm leading-[1.95] text-[var(--text-primary)]">{current?.keyEvents}</p>
            <div className="space-y-2 rounded-sm border p-3 text-[11px] hairline">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--text-secondary)]">彼时城名</span>
                <span className="font-serif tracking-[0.1em]">{current?.ancientCityName}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--text-secondary)]">今日遗存</span>
                <span className="text-right">{current?.relicToday}</span>
              </div>
              <div className="flex items-center justify-between gap-2 border-t pt-2 hairline">
                <span className="text-[var(--text-secondary)]">图上参照</span>
                {current?.centerCoord ? (
                  <button
                    type="button"
                    className="ink-link text-[var(--city-primary)]"
                    onClick={() =>
                      current.centerCoord
                        ? focusMap({
                            scope: 'landmarks',
                            lng: current.centerCoord[0],
                            lat: current.centerCoord[1],
                            label: `${current.eraName} · ${current.relicToday}`,
                          })
                        : undefined
                    }
                  >
                    今日遗存坐标 →
                  </button>
                ) : (
                  <span className="text-[var(--text-secondary)]">坐标待考</span>
                )}
              </div>
              <p className="text-[9px] leading-relaxed text-[var(--text-secondary)]">
                图上点位取自今日遗存，不代表古代城址中心。
              </p>
            </div>
          </div>
        </div>
      </div>

      <ol className="relative ml-2 border-l pl-6 hairline md:ml-4 md:pl-10">
        {data.map((item, index) => (
          <Reveal
            as="li"
            key={`${item.eraName}-${item.startYear}`}
            delay={index * 0.05}
            className={`relative pb-10 last:pb-0 ${index === active ? 'opacity-100' : 'opacity-90'}`}
          >
            <span
              aria-hidden
              className="absolute -left-[31px] top-2 h-2.5 w-2.5 rounded-full border-2 md:-left-[47px]"
              style={{
                borderColor: 'var(--city-primary)',
                background: index === active ? 'var(--city-primary)' : 'var(--bg-canvas)',
              }}
            />
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="font-serif text-xl tracking-[0.12em] md:text-2xl">{item.eraName}</h3>
              {item.epithet ? (
                <span className="text-[10px] tracking-[0.16em] text-[var(--city-primary)]">
                  {item.epithet}
                </span>
              ) : null}
              <span className="mono text-[10px] tracking-[0.1em] text-[var(--text-secondary)]">
                {item.periodRange}
              </span>
            </div>

            <div className="mt-3 grid gap-4 md:grid-cols-[1fr_220px]">
              <div>
                <p className="text-sm leading-[1.95] text-[var(--text-primary)]">{item.keyEvents}</p>
                <p className="mt-3 text-xs leading-relaxed text-[var(--text-secondary)]">
                  今日遗存 · {item.relicToday}
                </p>
              </div>
              <div className="space-y-2 rounded-sm border p-3 text-[11px] hairline">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[var(--text-secondary)]">彼时城名</span>
                  <span className="font-serif tracking-[0.1em]">{item.ancientCityName}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[var(--text-secondary)]">定位</span>
                  {item.centerCoord ? (
                    <button
                      type="button"
                      className="ink-link text-[var(--city-primary)]"
                      onClick={() =>
                        item.centerCoord
                          ? focusMap({
                              scope: 'landmarks',
                              lng: item.centerCoord[0],
                              lat: item.centerCoord[1],
                              label: `${item.eraName} · ${item.relicToday}`,
                            })
                          : undefined
                      }
                    >
                      图上寻迹 →
                    </button>
                  ) : (
                    <span className="text-[var(--text-secondary)]">待考</span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <VerificationTag status={item.verification} />
                  <SourceBadge sourceRefs={item.sourceRefs} sources={sources} />
                </div>
              </div>
            </div>
          </Reveal>
        ))}
      </ol>
    </div>
  );
}
