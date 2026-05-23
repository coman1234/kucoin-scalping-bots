import type { Config } from "tailwindcss";
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Light palette — same class names as before, new values
        bg:      "#ffffff",
        bg2:     "#f5f7fa",
        bg3:     "#edf0f4",
        border:  "#d1d9e0",
        text:    "#1c2128",
        text2:   "#57606a",
        text3:   "#8c959f",
        green:   "#1a7f37",
        "green-dim": "#dafbe1",
        red:     "#cf222e",
        "red-dim":   "#ffeef0",
        blue:    "#0969da",
        "blue-dim":  "#ddf4ff",
        amber:   "#9a6700",
        "amber-dim": "#fef3e2",
        purple:  "#8250df",
        "purple-dim":"#fbefff",
        cyan:    "#0598bc",
        "cyan-dim":  "#cff5fd",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
