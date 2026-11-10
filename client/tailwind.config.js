/** Tailwind 配置：CityLens 读城视觉系统。 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: 'var(--text-primary)',
        muted: 'var(--text-secondary)',
        canvas: 'var(--bg-canvas)',
        city: 'var(--city-primary)',
        city2: 'var(--city-secondary)',
        accent: 'var(--city-accent)',
      },
      fontFamily: {
        serif: ["'Noto Serif SC'", "'Source Han Serif SC'", "'Songti SC'", 'serif'],
        sans: ["'Inter'", "'PingFang SC'", "'Microsoft YaHei'", 'sans-serif'],
        mono: ["'JetBrains Mono'", "'DIN Alternate'", 'monospace'],
      },
      maxWidth: { page: '1280px' },
      transitionDuration: { theme: '800ms' },
      screens: { xs: '375px', md: '768px', lg: '1024px', xl: '1280px' },
    },
  },
  plugins: [],
};
