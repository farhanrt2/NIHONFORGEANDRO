import { useEffect, useMemo, useState } from "react";
import { countKotoba, countKanji, countMemorizedKana, countMemorizedKanji, getAllKotoba, getTarget, Kotoba } from "./db";
import ScreenLayout from "./ScreenLayout";
import Spinner from "./Spinner";
import KanaRain from "./KanaRain";

interface KotobaProgressProps { onClose: () => void; }

function Donut({ pct, sublabel, color, size = 180 }: { pct: number; sublabel: string; color: string; size?: number }) {
  const r = size * 0.35;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={size * 0.08} />
      <g style={{"--glow": color} as React.CSSProperties}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={size * 0.08}
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cy})`}
          style={{ transition: "stroke-dashoffset 0.8s ease, opacity 0.5s ease, filter 0.5s ease", filter: "drop-shadow(0 0 1px var(--glow)) drop-shadow(0 0 3px var(--glow))", animation: "donutGlow 3s ease-in-out infinite" }} />
      </g>
      <text x={cx} y={cy - 6} textAnchor="middle" fill="#fff" fontSize={size * 0.16} fontWeight="bold">{Math.round(pct)}%</text>
      <text x={cx} y={cy + 14} textAnchor="middle" fill="#aaa" fontSize={size * 0.1}>{sublabel}</text>
    </svg>
  );
}

const BTN_ACTIVE_GREEN = {"--btn-bg1":"#002010","--btn-bg2":"#2adb10","--btn-neon1":"#3aeb20","--btn-neon2":"#2adb10","--btn-text":"#000",fontSize:14,padding:"6px 14px"} as React.CSSProperties;
const BTN_ACTIVE_BLUE = {"--btn-bg1":"#000d1a","--btn-bg2":"#3a7fff","--btn-neon1":"#5a9fff","--btn-neon2":"#3a7fff","--btn-text":"#fff",fontSize:14,padding:"6px 14px"} as React.CSSProperties;
const BTN_ACTIVE_CYAN = {"--btn-bg1":"#001015","--btn-bg2":"#1ac8c8","--btn-neon1":"#3aebeb","--btn-neon2":"#1ac8c8","--btn-text":"#fff",fontSize:14,padding:"6px 14px"} as React.CSSProperties;
const BTN_INACTIVE = {"--btn-bg1":"#0a0a0a","--btn-bg2":"#3a3a4a","--btn-neon1":"#5a5a6a","--btn-neon2":"#3a3a4a","--btn-text":"#bbb",fontSize:14,padding:"6px 14px"} as React.CSSProperties;

export default function KotobaProgress({ onClose }: KotobaProgressProps) {
  const [loading, setLoading] = useState(true);
  const [totalKt, setTotalKt] = useState(0);
  const [totalKn, setTotalKn] = useState(0);
  const [hafalKana, setHafalKana] = useState(0);
  const [hafalKanji, setHafalKanji] = useState(0);
  const [all, setAll] = useState<Kotoba[]>([]);
  const [mode, setMode] = useState<"both" | "kana" | "kanji">("both");
  const [chunkSize, setChunkSize] = useState(100);
  const [progressMode, setProgressMode] = useState<"all" | "target">("all");
  const [kanaTarget, setKanaTarget] = useState(0);
  const [kanjiTarget, setKanjiTarget] = useState(0);

  async function load() {
    setLoading(true);
    const [tkt, tkn, hk, hkj, a, ktarg, kjtarg] = await Promise.all([
      countKotoba(), countKanji(), countMemorizedKana(), countMemorizedKanji(), getAllKotoba(), getTarget("kana"), getTarget("kanji"),
    ]);
    setTotalKt(tkt); setTotalKn(tkn); setHafalKana(hk); setHafalKanji(hkj); setAll(a); setKanaTarget(ktarg); setKanjiTarget(kjtarg);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const chunks = useMemo(() => {
    if (all.length === 0) return [];
    const result: {
      start: number; end: number; total: number;
      kanaMem: number; kanjiCount: number; kanjiMem: number;
      kanaPct: number; kanjiPct: number; combinedPct: number;
    }[] = [];
    for (let i = 0; i < all.length; i += chunkSize) {
      const slice = all.slice(i, i + chunkSize);
      const kanaMem = slice.filter(w => w.memorized === 1).length;
      const kanjiSlice = slice.filter(w => w.kanji && w.kanji !== "-" && w.kanji !== "ー");
      const kanjiMem = kanjiSlice.filter(w => w.memorized_kanji === 1).length;
      const kanaPct = slice.length ? (kanaMem / slice.length) * 100 : 0;
      const kanjiPct = kanjiSlice.length ? (kanjiMem / kanjiSlice.length) * 100 : 0;
      const combinedPct = mode === "kana" ? kanaPct : mode === "kanji" ? kanjiPct : (kanaPct + kanjiPct) / 2;
      result.push({
        start: slice[0].id, end: slice[slice.length - 1].id,
        total: slice.length, kanaMem, kanjiCount: kanjiSlice.length, kanjiMem,
        kanaPct, kanjiPct, combinedPct,
      });
    }
    result.sort((a, b) => b.combinedPct - a.combinedPct);
    return result;
  }, [all, chunkSize, mode]);

  const weakest5 = useMemo(() => [...chunks].sort((a, b) => a.combinedPct - b.combinedPct).slice(0, 5), [chunks]);

  const kanaPct = totalKt ? (hafalKana / totalKt) * 100 : 0;
  const kanjiPct = totalKn ? (hafalKanji / totalKn) * 100 : 0;
  const useKanaPct = progressMode === "target" && kanaTarget > 0 ? Math.min(100, (hafalKana / kanaTarget) * 100) : kanaPct;
  const useKanjiPct = progressMode === "target" && kanjiTarget > 0 ? Math.min(100, (hafalKanji / kanjiTarget) * 100) : kanjiPct;
  const useKanaDenom = progressMode === "target" && kanaTarget > 0 ? kanaTarget : totalKt;
  const useKanjiDenom = progressMode === "target" && kanjiTarget > 0 ? kanjiTarget : totalKn;

  function modeBtnStyle(btnMode: typeof mode) {
    if (mode !== btnMode) return BTN_INACTIVE;
    return btnMode === "kanji" ? BTN_ACTIVE_BLUE : BTN_ACTIVE_GREEN;
  }

  function chunkBtnStyle(v: number) {
    return chunkSize === v ? BTN_ACTIVE_CYAN : BTN_INACTIVE;
  }

  return (
    <ScreenLayout title="KOTOBA PROGRESS" subtitle="VISUALISASI HAFALAN:" onClose={onClose} logoCentered logo={80} width={1000} fillHeight>
      <style>{`
        @keyframes sectionGlow {
          0%, 100% { box-shadow: 0 0 12px rgba(47,230,230,0.15), 0 0 30px rgba(47,230,230,0.08), 0 0 50px rgba(57,255,20,0.05); }
          50% { box-shadow: 0 0 20px rgba(47,230,230,0.4), 0 0 50px rgba(47,230,230,0.2), 0 0 70px rgba(57,255,20,0.12), 0 0 90px rgba(77,148,255,0.08); }
        }
        @keyframes donutGlow {
          0%, 100% { opacity: 0.9; filter: drop-shadow(0 0 0px var(--glow)) drop-shadow(0 0 2px var(--glow)); }
          50% { opacity: 1; filter: drop-shadow(0 0 1px var(--glow)) drop-shadow(0 0 4px var(--glow)) drop-shadow(0 0 8px var(--glow)); }
        }
      `}</style>
      {loading ? <Spinner text="Memuat progress..." full /> : (
        <div style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column" }}>
          <KanaRain />
          <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", flex: 1 }}>
          <div style={{ background: "linear-gradient(135deg, rgba(0,50,50,0.5) 0%, #0d0d0d 80%)", borderRadius: 16, padding: "20px 20px", border: "1px solid rgba(47,230,230,0.25)", boxShadow: "0 4px 24px rgba(0,0,0,0.4)", animation: "sectionGlow 3s ease-in-out infinite, floatIn 0.6s ease both", display: "flex", flexDirection: "column", gap: 14, flex: 1, overflowY: "auto" }}>
          <div className="nf-section" style={{ color: "var(--cyan)", borderBottomColor: "rgba(47,230,230,0.3)", marginTop: 0 }}>📊 PROGRESS CHART</div>
          {/* Row 1: Mode + Chunk filter */}
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "10px 14px", background: "rgba(255,255,255,0.03)", borderRadius: 10 }}>
            <span style={{ color: "#aaa", fontSize: 13 }}>Mode:</span>
            <button className="nf-btn nf-btn-neon" style={modeBtnStyle("both")} onClick={() => setMode("both")}>Kana + Kanji</button>
            <button className="nf-btn nf-btn-neon" style={modeBtnStyle("kana")} onClick={() => setMode("kana")}>Kana Only</button>
            <button className="nf-btn nf-btn-neon" style={modeBtnStyle("kanji")} onClick={() => setMode("kanji")}>Kanji Only</button>
            <div style={{ flex: 1 }} />
            <button className="nf-btn nf-btn-neon" style={progressMode === "target" ? {"--btn-bg1":"#151000","--btn-bg2":"#ccaa00","--btn-neon1":"#ffdd44","--btn-neon2":"#ccaa00","--btn-text":"#000",fontSize:14,padding:"6px 14px"} as React.CSSProperties : {"--btn-bg1":"#0a0a0a","--btn-bg2":"#3a3a4a","--btn-neon1":"#5a5a6a","--btn-neon2":"#3a3a4a","--btn-text":"#bbb",fontSize:14,padding:"6px 14px"} as React.CSSProperties}
              onClick={() => setProgressMode("target")}>🎯 Target</button>
            <button className="nf-btn nf-btn-neon" style={progressMode === "all" ? {"--btn-bg1":"#0a1220","--btn-bg2":"#3a5a8a","--btn-neon1":"#5a8abb","--btn-neon2":"#3a5a8a","--btn-text":"#fff",fontSize:14,padding:"6px 14px"} as React.CSSProperties : {"--btn-bg1":"#0a0a0a","--btn-bg2":"#3a3a4a","--btn-neon1":"#5a5a6a","--btn-neon2":"#3a3a4a","--btn-text":"#bbb",fontSize:14,padding:"6px 14px"} as React.CSSProperties}
              onClick={() => setProgressMode("all")}>📊 All DB</button>
            <span style={{ color: "#aaa", fontSize: 13 }}>Chunk:</span>
            {[50, 100, 200].map(v => (
              <button key={v} className="nf-btn nf-btn-neon" style={chunkBtnStyle(v)} onClick={() => setChunkSize(v)}>{v}</button>
            ))}
          </div>

          {/* Row 2: Donut charts */}
          <div style={{ display: "flex", gap: 24, justifyContent: "center", alignItems: "center", flexWrap: "wrap", padding: "12px 0" }}>
            {(mode === "both" || mode === "kana") && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <Donut pct={useKanaPct} sublabel={`${hafalKana}/${useKanaDenom}`} color="#39ff14" size={140} />
                <span style={{ fontSize: 15, fontWeight: 700, color: "#39ff14" }}>KANA</span>
              </div>
            )}
            {(mode === "both" || mode === "kanji") && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <Donut pct={useKanjiPct} sublabel={`${hafalKanji}/${useKanjiDenom}`} color="#4d94ff" size={140} />
                <span style={{ fontSize: 15, fontWeight: 700, color: "#4d94ff" }}>KANJI</span>
              </div>
            )}
          </div>

          {/* Row 3: Progress Bars */}
          {(mode === "both" || mode === "kana") && (
            <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 14px", background: "rgba(255,255,255,0.03)", borderRadius: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: "#39ff14", minWidth: 50, whiteSpace: "nowrap" }}>Kana</span>
              <div style={{ flex: 1, height: 28, background: "rgba(255,255,255,0.06)", borderRadius: 6, overflow: "hidden" }}>
                <div style={{ width: `${useKanaPct}%`, height: 28, background: "linear-gradient(90deg,#39ff14,#2adb10)", borderRadius: 6, transition: "width 0.6s ease" }} />
              </div>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#fff", minWidth: 90, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{hafalKana}/{useKanaDenom} ({Math.round(useKanaPct)}%)</span>
            </div>
          )}
          {(mode === "both" || mode === "kanji") && (
            <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 14px", background: "rgba(255,255,255,0.03)", borderRadius: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: "#4d94ff", minWidth: 50, whiteSpace: "nowrap" }}>Kanji</span>
              <div style={{ flex: 1, height: 28, background: "rgba(255,255,255,0.06)", borderRadius: 6, overflow: "hidden" }}>
                <div style={{ width: `${useKanjiPct}%`, height: 28, background: "linear-gradient(90deg,#4d94ff,#3a7fff)", borderRadius: 6, transition: "width 0.6s ease" }} />
              </div>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#fff", minWidth: 90, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{hafalKanji}/{useKanjiDenom} ({Math.round(useKanjiPct)}%)</span>
            </div>
          )}

          {/* Row 3b: Sisa belum hafal */}
          <div style={{ textAlign: "center", padding: "4px 0" }}>
            <span style={{ fontSize: 14, color: "#888" }}>Sisa belum dihafal: </span>
            {(mode === "both" || mode === "kana") && (
              <span style={{ fontSize: 16, fontWeight: 700, color: "#ff6b6b", marginLeft: 4 }}>Kana: {Math.max(0, useKanaDenom - hafalKana)}</span>
            )}
            {(mode === "both" || mode === "kanji") && (
              <span style={{ fontSize: 16, fontWeight: 700, color: "#ff6b6b", marginLeft: mode === "both" ? 14 : 4 }}>Kanji: {Math.max(0, useKanjiDenom - hafalKanji)}</span>
            )}
          </div>

          {/* Target banner */}
          {progressMode === "target" && (
            <div style={{ background: kanaTarget > 0 && kanjiTarget > 0 ? "rgba(255,204,0,0.06)" : "rgba(255,45,85,0.06)", border: "1px solid rgba(255,204,0,0.2)", borderRadius: 12, padding: "10px 16px", textAlign: "center" }}>
              {kanaTarget > 0 || kanjiTarget > 0 ? (
                <span style={{ fontSize: 15, fontWeight: 700, color: "#ffcc00" }}>
                  🎯 TARGET: {kanaTarget > 0 ? `Kana ${hafalKana}/${kanaTarget}` : ""}{kanaTarget > 0 && kanjiTarget > 0 ? " | " : ""}{kanjiTarget > 0 ? `Kanji ${hafalKanji}/${kanjiTarget}` : ""}
                </span>
              ) : (
                <span style={{ fontSize: 14, color: "#ff6b6b" }}>⚠️ Target belum diset. Set target dulu via Flashcard → 🎯 Set</span>
              )}
            </div>
          )}

          {/* Row 4: Top 5 Terlemah */}
          {weakest5.length > 0 && (
            <div style={{ background: "rgba(255,45,85,0.06)", border: "1px solid rgba(255,45,85,0.2)", borderRadius: 12, padding: "12px 16px" }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#ff6b6b", marginBottom: 8 }}>⚠️ TOP 5 RANGE TERLEMAH</div>
              {weakest5.map((ch, i) => (
                <div key={ch.start} style={{ display: "flex", gap: 10, alignItems: "center", padding: "4px 0", borderBottom: i < weakest5.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none" }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#ff6b6b", minWidth: 24 }}>#{i + 1}</span>
                  <span style={{ fontSize: 14, color: "#aaa", minWidth: 72, fontVariantNumeric: "tabular-nums" }}>#{ch.start}-{ch.end}</span>
                  <div style={{ flex: 1, display: "flex", gap: 6, alignItems: "center" }}>
                    {(mode === "both" || mode === "kana") && (
                      <div style={{ flex: 1, height: 14, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ width: `${ch.kanaPct}%`, height: 14, background: "linear-gradient(90deg,#39ff14,#2adb10)", borderRadius: 3, transition: "width 0.4s" }} />
                      </div>
                    )}
                    {(mode === "both" || mode === "kanji") && (
                      <div style={{ flex: 1, height: 14, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ width: `${ch.kanjiPct}%`, height: 14, background: "linear-gradient(90deg,#4d94ff,#3a7fff)", borderRadius: 3, transition: "width 0.4s" }} />
                      </div>
                    )}
                  </div>
                  <span style={{ fontSize: 14, color: "#888", minWidth: 44, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                    {Math.round(mode === "both" ? (ch.kanaPct + ch.kanjiPct) / 2 : mode === "kana" ? ch.kanaPct : ch.kanjiPct)}%
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Row 5: Full breakdown sorted strongest → weakest */}
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#aaa", padding: "4px 12px" }}>
              BREAKDOWN PER RANGE: <span style={{ color: "#666" }}>(terkuat → terlemah)</span>
            </div>
            {chunks.map((ch, i) => (
              <div key={ch.start} style={{
                display: "flex", gap: 10, alignItems: "center", padding: "6px 12px",
                background: "rgba(255,255,255,0.02)", borderRadius: 6,
                borderLeft: i < 5 ? "3px solid #ff6b6b" : "3px solid transparent",
              }}>
                <span style={{ fontSize: 14, color: "#ccc", minWidth: 72, fontVariantNumeric: "tabular-nums" }}>#{ch.start}-{ch.end}</span>
                <div style={{ flex: 1, display: "flex", gap: 6, alignItems: "center" }}>
                  {(mode === "both" || mode === "kana") && (
                    <div style={{ flex: 1, height: 16, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden", position: "relative" }}>
                      <div style={{ width: `${ch.kanaPct}%`, height: 16, background: "linear-gradient(90deg,#39ff14,#2adb10)", borderRadius: 3, transition: "width 0.4s" }} />
                      <span style={{ position: "absolute", left: 4, top: 0, fontSize: 10, color: "#000", fontWeight: 700, lineHeight: "16px" }}>{ch.kanaMem}/{ch.total}</span>
                    </div>
                  )}
                  {(mode === "both" || mode === "kanji") && (
                    <div style={{ flex: 1, height: 16, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden", position: "relative" }}>
                      <div style={{ width: `${ch.kanjiPct}%`, height: 16, background: "linear-gradient(90deg,#4d94ff,#3a7fff)", borderRadius: 3, transition: "width 0.4s" }} />
                      <span style={{ position: "absolute", left: 4, top: 0, fontSize: 10, color: "#fff", fontWeight: 700, lineHeight: "16px" }}>{ch.kanjiMem}/{ch.kanjiCount}</span>
                    </div>
                  )}
                </div>
                <span style={{ fontSize: 13, color: "#888", minWidth: 44, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                  {Math.round(mode === "both" ? (ch.kanaPct + ch.kanjiPct) / 2 : mode === "kana" ? ch.kanaPct : ch.kanjiPct)}%
                </span>
              </div>
            ))}
          </div>
        </div>
        </div>
        </div>
      )}
    </ScreenLayout>
  );
}
