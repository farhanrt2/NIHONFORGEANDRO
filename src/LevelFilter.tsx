// Chips filter level (N5..N1 + ALL) — dipakai di Flashcard,
// KotobaTest, KanjiTest, dan Dictionary.
export const LEVELS = ["N5", "N4", "N3", "N2", "N1"] as const;
export type Level = typeof LEVELS[number] | "all";

interface LevelFilterProps {
  value: string; // "all" atau level
  onChange: (level: string) => void;
  compact?: boolean;
}

const COLORS: Record<string, { bg1: string; bg2: string; neon1: string; neon2: string; text: string }> = {
  N5:   { bg1: "#002010", bg2: "#2adb10", neon1: "#3aeb20", neon2: "#2adb10", text: "#000" },
  N4:   { bg1: "#000d1a", bg2: "#3a7fff", neon1: "#5a9fff", neon2: "#3a7fff", text: "#fff" },
  N3:   { bg1: "#151000", bg2: "#ccaa00", neon1: "#ffdd44", neon2: "#ccaa00", text: "#000" },
  N2:   { bg1: "#100520", bg2: "#9a3dff", neon1: "#b86aff", neon2: "#9a3dff", text: "#fff" },
  N1:   { bg1: "#200005", bg2: "#e03040", neon1: "#ff5a6a", neon2: "#e03040", text: "#fff" },
  GENERAL: { bg1: "#0a0a0a", bg2: "#3a3a4a", neon1: "#5a5a6a", neon2: "#3a3a4a", text: "#bbb" },
};

export default function LevelFilter({ value, onChange, compact }: LevelFilterProps) {
  const font = compact ? 11 : 14;
  const pad = compact ? "3px 8px" : "7px 14px";
  return (
    <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
      {["all", ...LEVELS].map((lvl) => {
        const c = lvl === "all"
          ? { bg1: "#0a0a1a", bg2: "#445568", neon1: "#667799", neon2: "#445568", text: "#fff" }
          : COLORS[lvl];
        const active = value === lvl;
        return (
          <button
            key={lvl}
            className="nf-btn nf-btn-neon"
            style={{
              "--btn-bg1": active ? c.bg1 : "#141414",
              "--btn-bg2": active ? c.bg2 : "#2a2a2a",
              "--btn-neon1": active ? c.neon1 : "#444",
              "--btn-neon2": active ? c.neon2 : "#2a2a2a",
              "--btn-text": active ? c.text : "#777",
              fontSize: font,
              padding: pad,
            } as React.CSSProperties}
            onClick={() => onChange(lvl)}
          >
            {lvl === "all" ? "ALL" : lvl}
          </button>
        );
      })}
    </div>
  );
}