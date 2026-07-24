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
        // Cozytrack design system v2 — "Sunset"
        bg:       "#120e26", // studio floor
        surface:  "#191338", // panels / topbar
        card:     "#221a45", // tiles / cards
        "card-hi":"#2b2154", // hover / elevated
        text: {
          DEFAULT: "#efeaff",
          2:       "#9a90c2",
          3:       "#6f65a0",
        },
        accent: {
          DEFAULT: "#ff4d7d",
          hi:      "#ff6b9d",
          // Dark text used on solid-accent and gradient record surfaces
          ink:     "#2b0b18",
        },
        ok:   "#46d68c", // connected / uploaded
        warn: "#ffb347", // built-in mic / processing
        rec:  "#ff3b4d", // record / clipping
      },
      borderColor: {
        subtle: "rgba(210,190,255,0.10)",
        strong: "rgba(210,190,255,0.14)",
      },
      borderRadius: {
        panel: "10px",
      },
    },
  },
  plugins: [],
};

export default config;
