/** @type {import("tailwindcss").Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx,mjs}'],
  theme: {
    extend: {
      colors: {
        void: 'rgb(var(--void) / <alpha-value>)',
        graphite: 'rgb(var(--graphite) / <alpha-value>)',
        navy: 'rgb(var(--navy) / <alpha-value>)',
        panel: {
          1: 'rgb(var(--panel-1) / <alpha-value>)',
          2: 'rgb(var(--panel-2) / <alpha-value>)',
          3: 'rgb(var(--panel-3) / <alpha-value>)'
        },
        line: {
          subtle: 'rgb(var(--line-subtle) / <alpha-value>)',
          strong: 'rgb(var(--line-strong) / <alpha-value>)'
        },
        ink: {
          primary: 'rgb(var(--ink-primary) / <alpha-value>)',
          secondary: 'rgb(var(--ink-secondary) / <alpha-value>)',
          muted: 'rgb(var(--ink-muted) / <alpha-value>)'
        },
        violet: 'rgb(var(--violet) / <alpha-value>)',
        ultraviolet: 'rgb(var(--ultraviolet) / <alpha-value>)',
        cyan: 'rgb(var(--cyan) / <alpha-value>)',
        aqua: 'rgb(var(--aqua) / <alpha-value>)',
        positive: 'rgb(var(--positive) / <alpha-value>)',
        negative: 'rgb(var(--negative) / <alpha-value>)',
        magenta: 'rgb(var(--magenta) / <alpha-value>)',
        amber: 'rgb(var(--amber) / <alpha-value>)',
        signal: 'rgb(var(--blue) / <alpha-value>)'
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'Segoe UI', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"IBM Plex Mono"', '"JetBrains Mono"', 'Consolas', 'ui-monospace', 'monospace']
      },
      boxShadow: {
        panel: '0 1px 0 0 rgb(255 255 255 / 0.03) inset, 0 18px 48px -24px rgb(0 0 0 / 0.85)',
        lift: '0 24px 64px -32px rgb(0 0 0 / 0.9)',
        'glow-violet': '0 0 0 1px rgb(var(--violet) / 0.35), 0 12px 40px -18px rgb(var(--violet) / 0.55)',
        'glow-cyan': '0 0 0 1px rgb(var(--cyan) / 0.28), 0 12px 40px -20px rgb(var(--cyan) / 0.45)'
      },
      backgroundImage: {
        aurora:
          'radial-gradient(1100px 520px at 8% -12%, rgb(var(--violet) / 0.16), transparent 62%), radial-gradient(900px 460px at 92% -6%, rgb(var(--cyan) / 0.09), transparent 58%), radial-gradient(700px 500px at 50% 110%, rgb(var(--blue) / 0.06), transparent 60%)',
        'grid-faint':
          'linear-gradient(rgb(var(--line-subtle) / 0.26) 1px, transparent 1px), linear-gradient(90deg, rgb(var(--line-subtle) / 0.26) 1px, transparent 1px)'
      },
      borderRadius: {
        panel: '0.75rem'
      },
      transitionTimingFunction: {
        terminal: 'cubic-bezier(0.22, 1, 0.36, 1)'
      },
      keyframes: {
        'tick-up': {
          '0%': { color: 'rgb(var(--positive))', textShadow: '0 0 18px rgb(var(--positive) / 0.55)' },
          '100%': { color: 'inherit', textShadow: 'none' }
        },
        'tick-down': {
          '0%': { color: 'rgb(var(--negative))', textShadow: '0 0 18px rgb(var(--negative) / 0.5)' },
          '100%': { color: 'inherit', textShadow: 'none' }
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '0.45' },
          '50%': { opacity: '1' }
        },
        shimmer: {
          '0%': { backgroundPosition: '-400px 0' },
          '100%': { backgroundPosition: '400px 0' }
        }
      },
      animation: {
        'tick-up': 'tick-up 650ms ease-out',
        'tick-down': 'tick-down 650ms ease-out',
        'pulse-soft': 'pulse-soft 2.4s ease-in-out infinite',
        shimmer: 'shimmer 1.6s linear infinite'
      }
    }
  },
  plugins: []
};
