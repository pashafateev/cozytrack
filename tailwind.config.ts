import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      keyframes: {
        "toast-fade-in": {
          "0%": { opacity: "0", transform: "translate(-50%, -8px)" },
          "100%": { opacity: "1", transform: "translate(-50%, 0)" },
        },
      },
      animation: {
        "toast-fade-in": "toast-fade-in 0.2s ease-out",
      },
      colors: {
        cozy: {
          50: "#f5f5f6",
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
    },
  },
  plugins: [],
};

export default config;
