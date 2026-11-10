/**
 * 首屏水墨粒子画布（PRD 4.4 / 3.3）。
 * - 自适应 DPR；页面不可见或离开视口时暂停；
 * - prefers-reduced-motion 下只绘制静态一帧；
 * - 帧率持续低于 30fps 时自动降级（减少粒子并停止动画）。
 */
import { useEffect, useRef } from 'react';
import { useReducedMotion } from '../../hooks/useReducedMotion';

interface InkParticle {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  alpha: number;
  tint: number;
}

function readInkColors(): { ink: string; city: [number, number, number] } {
  const styles = getComputedStyle(document.documentElement);
  const dark = document.documentElement.dataset.theme === 'dark';
  const ink = dark ? '234, 230, 223' : '30, 30, 30';
  const primary = styles.getPropertyValue('--city-primary').trim() || '#8C3F2B';
  const hex = primary.replace('#', '');
  const city: [number, number, number] = [
    Number.parseInt(hex.slice(0, 2), 16) || 140,
    Number.parseInt(hex.slice(2, 4), 16) || 63,
    Number.parseInt(hex.slice(4, 6), 16) || 43,
  ];
  return { ink, city };
}

export function InkCanvas({ className = '' }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    let width = 0;
    let height = 0;
    let particles: InkParticle[] = [];
    let frame = 0;
    let raf = 0;
    let running = true;
    let degraded = false;
    let lastFpsCheck = performance.now();
    let framesSinceCheck = 0;
    let lowFpsStreak = 0;
    let colors = readInkColors();

    const seedParticles = (count: number): InkParticle[] => {
      const next: InkParticle[] = [];
      for (let i = 0; i < count; i += 1) {
        next.push({
          x: Math.random() * width,
          y: Math.random() * height,
          r: 8 + Math.random() * 46,
          vx: (Math.random() - 0.5) * 0.14,
          vy: -0.03 - Math.random() * 0.09,
          alpha: 0.02 + Math.random() * 0.05,
          tint: Math.random(),
        });
      }
      return next;
    };

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      colors = readInkColors();
      const base = width < 768 ? 18 : 40;
      particles = seedParticles(degraded ? Math.round(base / 3) : base);
      draw(0);
    };

    const draw = (time: number): void => {
      context.clearRect(0, 0, width, height);

      // 淡墨远山：两笔横向晕染
      for (let layer = 0; layer < 2; layer += 1) {
        const gradient = context.createLinearGradient(0, height * 0.55, 0, height);
        gradient.addColorStop(0, `rgba(${colors.ink}, 0)`);
        gradient.addColorStop(0.55, `rgba(${colors.ink}, ${0.035 - layer * 0.012})`);
        gradient.addColorStop(1, `rgba(${colors.ink}, 0)`);
        context.fillStyle = gradient;
        context.beginPath();
        context.ellipse(
          width * (0.28 + layer * 0.44) + Math.sin(time / 9000 + layer) * 22,
          height * (0.74 + layer * 0.06),
          width * 0.42,
          height * 0.16,
          0,
          0,
          Math.PI * 2,
        );
        context.fill();
      }

      for (const particle of particles) {
        const gradient = context.createRadialGradient(
          particle.x,
          particle.y,
          0,
          particle.x,
          particle.y,
          particle.r,
        );
        const tint = colors.city;
        const useTint = particle.tint > 0.62;
        const base = useTint ? `${tint[0]}, ${tint[1]}, ${tint[2]}` : colors.ink;
        gradient.addColorStop(0, `rgba(${base}, ${particle.alpha})`);
        gradient.addColorStop(1, `rgba(${base}, 0)`);
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(particle.x, particle.y, particle.r, 0, Math.PI * 2);
        context.fill();
      }
    };

    const tick = (now: number): void => {
      if (!running) return;
      frame += 1;
      for (const particle of particles) {
        particle.x += particle.vx;
        particle.y += particle.vy;
        if (particle.y < -particle.r) particle.y = height + particle.r;
        if (particle.x < -particle.r) particle.x = width + particle.r;
        if (particle.x > width + particle.r) particle.x = -particle.r;
      }
      draw(now);

      framesSinceCheck += 1;
      if (now - lastFpsCheck >= 1600) {
        const fps = (framesSinceCheck * 1000) / (now - lastFpsCheck);
        framesSinceCheck = 0;
        lastFpsCheck = now;
        if (fps < 30) {
          lowFpsStreak += 1;
          if (lowFpsStreak >= 2) {
            degraded = true;
            running = false;
            particles = seedParticles(Math.max(6, Math.round(particles.length / 3)));
            draw(now);
            return;
          }
        } else {
          lowFpsStreak = 0;
        }
      }
      raf = requestAnimationFrame(tick);
    };

    const start = (): void => {
      if (!running) return;
      if (document.hidden) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };

    const stop = (): void => {
      cancelAnimationFrame(raf);
    };

    resize();
    if (reduced) {
      draw(performance.now());
    } else {
      raf = requestAnimationFrame(tick);
    }

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const onVisibility = (): void => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const intersection = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        if (visible) start();
        else stop();
      },
      { threshold: 0.05 },
    );
    intersection.observe(canvas);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
      intersection.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [reduced]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}
      style={{ opacity: reduced ? 0.7 : 1 }}
    />
  );
}
