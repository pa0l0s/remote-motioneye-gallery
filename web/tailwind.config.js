/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0A0B0E",
        surface: "#14161C",
        "surface-2": "#1B1E26",
        hairline: "rgba(255,255,255,0.08)",
        amber: "#FFC53D",
        "amber-dim": "#C9963B",
        teal: "#4EC2C6",
        fg: "#E7E9EC",
        muted: "#8A8F98",
      },
      fontFamily: {
        display: ['"Bricolage Grotesque"', "system-ui", "sans-serif"],
        sans: ['"Schibsted Grotesk"', "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(255,197,61,0.4), 0 0 24px -4px rgba(255,197,61,0.35)",
      },
    },
  },
  plugins: [],
};
