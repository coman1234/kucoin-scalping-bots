import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // TradingView light-theme palette
        tv: {
          bg:           "#ffffff",
          bg2:          "#f0f3fa",
          bg3:          "#e8ecf2",
          hover:        "#f5f7fd",
          active:       "#e3eaff",
          border:       "#e0e3eb",
          border2:      "#eef0f5",
          text:         "#131722",
          text2:        "#787b86",
          text3:        "#b2b5be",
          green:        "#26a69a",
          "green-dim":  "#e8f7f5",
          red:          "#ef5350",
          "red-dim":    "#fdecea",
          blue:         "#2962ff",
          "blue-dim":   "#e3eaff",
          "blue-dark":  "#1848cc",
          amber:        "#f5a623",
          "amber-dim":  "#fef3e2",
          purple:       "#9c27b0",
          "purple-dim": "#f3e5f5",
        },
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "Inter", "Roboto", "sans-serif"],
        mono: ["JetBrains Mono", "Consolas", "monospace"],
      },
      boxShadow: {
        sm:       "0 1px 3px rgba(0,0,0,0.07)",
        md:       "0 4px 12px rgba(0,0,0,0.10)",
        lg:       "0 8px 24px rgba(0,0,0,0.12)",
        dropdown: "0 8px 24px rgba(0,0,0,0.14)",
      },
    },
  },
  plugins: [],
};

export default config;
