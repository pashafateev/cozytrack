import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-jakarta)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains)', 'ui-monospace', 'monospace'],
      },
      keyframes: {
        "toast-fade-in": {
          "0%": { opacity: "0", transform: "translate(-50%, -8px)" },
          "100%": { opacity: "1", transform: "translate(-50%, 0)" },
        },
        "page-enter": {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "rec-pulse": {
          "0%":   { transform: "scale(1)",    opacity: "0.6" },
          "50%":  { transform: "scale(1.55)", opacity: "0"   },
          "100%": { transform: "scale(1.55)", opacity: "0"   },
        },
        "blink": {
          "50%": { opacity: "0" },
        },
      },
      animation: {
        "toast-fade-in": "toast-fade-in 0.2s ease-out",
        "page-enter":    "page-enter 0.22s ease forwards",
        "rec-pulse":     "rec-pulse 1.4s ease-out infinite",
        "blink":         "blink 1s step-end infinite",
      },
      colors: {
        // Cozytrack design system v1
        bg:       "#0d0b08", // studio floor
        surface:  "#141209", // panels / topbar
        card:     "#1c1812", // tiles / cards
        "card-hi":"#231f16", // hover / elevated
        text: {
          DEFAULT: "#ede7db",
          2:       "#9a8f7e",
          3:       "#574f44",
        },
        amber: {
          DEFAULT: "#c87840",
          hi:      "#dc9050",
        },
        ok:   "#52c97a", // connected / healthy
        warn: "#e8a830", // warning
        rec:  "#e85050", // recording / error

        // Legacy `cozy` palette kept for backward-compat while we migrate callers
        cozy: {
          50:  "#f5f5f6",
          100: "#e5e5e8",
          200: "#cfd0d4",
          300: "#adaeb5",
          400: "#84858f",
          500: "#696a74",
          600: "#5a5a63",
          700: "#4c4d54",
          800: "#434349",
          900: "#3b3b40",
          950: "#1e1e21",
        },
      },
      borderColor: {
        subtle: "rgba(255,240,210,0.07)",
        strong: "rgba(255,240,210,0.13)",
      },
      borderRadius: {
        panel: "10px",
      },
    },
  },
  plugins: [],
};

export default config;
