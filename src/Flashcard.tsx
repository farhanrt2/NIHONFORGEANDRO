import { useEffect, useState, useRef, useLayoutEffect } from "react";
import { countKotoba, countKanji, countKotobaByLevel, countKanjiByLevel, countMemorizedKana, countMemorizedKanji, getKotobaRange, getKanjiKotobaRange, toggleMemorized, getTarget, setTarget, getSetting, setSetting, Kotoba } from "./db";
import { speak } from "./tts";
import ScreenLayout from "./ScreenLayout";
import LevelFilter from "./LevelFilter";

const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
import Spinner from "./Spinner";

interface FlashcardProps { onClose: () => void; }

const FONT_SIZES = [32, 40, 48, 56, 64, 72, 80, 90, 100, 120, 140];

export default function Flashcard({ onClose }: FlashcardProps) {
  const [total, setTotal] = useState(0);
  const [kanjiTotal, setKanjiTotal] = useState(0);
  const [hafalKana, setHafalKana] = useState(0);
  const [hafalKanji, setHafalKanji] = useState(0);
  const [rangeStart, setRangeStart] = useState("1");
  const [rangeEnd, setRangeEnd] = useState("20");
  const [cards, setCards] = useState<Kotoba[]>([]);
  const [idx, setIdx] = useState(0);
  const [showMeaning, setShowMeaning] = useState(false);
  const [kanjiMode, setKanjiMode] = useState(false);
  const [reverseMode, setReverseMode] = useState(false);
  const [leftFont, setLeftFont] = useState(44);
  const [rightFont, setRightFont] = useState(36);
  const [loading, setLoading] = useState(true);
  const [autoPlay, setAutoPlay] = useState(false);
  const [rawCards, setRawCards] = useState<Kotoba[]>([]);
  const [filter, setFilter] = useState<"all" | "hafal" | "belum">("all");
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [levelKanaCount, setLevelKanaCount] = useState(0);
  const [levelKanjiCount, setLevelKanjiCount] = useState(0);
  const [showTarget, setShowTarget] = useState(false);
  const [kanaTarget, setKanaTarget] = useState(0);
  const [kanjiTarget, setKanjiTarget] = useState(0);
  const [showTargetInput, setShowTargetInput] = useState(false);
  const [editKanaTarget, setEditKanaTarget] = useState(0);
  const [editKanjiTarget, setEditKanjiTarget] = useState(0);
  const [showNav, setShowNav] = useState(false);
  // filter prefs dipersist ke settings — balik ke flashcard nggak perlu set ulang
  const [restored, setRestored] = useState(false);

  const cardRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); setShowMeaning(false); }
      else if (e.key === "ArrowRight") { e.preventDefault(); setIdx(i => Math.min(cards.length - 1, i + 1)); setShowMeaning(false); }
      else if (e.key === " " && cards.length > 0) { e.preventDefault(); setShowMeaning(v => !v); }
      else if (e.key === "Enter" && cards.length > 0) { e.preventDefault(); handleHafal(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cards.length, idx, handleHafal]);

  useEffect(() => {
    (async () => {
      const [t, kt, hk, hkj, ktarg, kjtarg] = await Promise.all([countKotoba(), countKanji(), countMemorizedKana(), countMemorizedKanji(), getTarget("kana"), getTarget("kanji")]);
      setTotal(t); setKanjiTotal(kt); setHafalKana(hk); setHafalKanji(hkj); setKanaTarget(ktarg); setKanjiTarget(kjtarg);

      // restore filter terakhir (level / hafal / range / mode)
      try {
        const raw = await getSetting("flashcard_prefs");
        console.log("[fc-prefs] restore baca:", raw);
        if (raw) {
          const p = JSON.parse(raw) as { levelFilter?: string; filter?: string; rangeStart?: string; rangeEnd?: string; kanjiMode?: boolean };
          if (typeof p.levelFilter === "string") {
            setLevelFilter(p.levelFilter);
            // ambil hitungan per-level — kalau nggak, "maks." bakal nampil 0
            if (p.levelFilter !== "all") {
              const [k, j] = await Promise.all([countKotobaByLevel(p.levelFilter), countKanjiByLevel(p.levelFilter)]);
              setLevelKanaCount(k); setLevelKanjiCount(j);
            }
          }
          if (p.filter === "all" || p.filter === "hafal" || p.filter === "belum") setFilter(p.filter);
          if (typeof p.kanjiMode === "boolean") setKanjiMode(p.kanjiMode);
          let rs = parseInt(p.rangeStart ?? "", 10);
          let re_ = parseInt(p.rangeEnd ?? "", 10);
          if (!isNaN(rs) && rs >= 1 && !isNaN(re_) && re_ >= 1) {
            if (re_ < rs) { const tmp = rs; rs = re_; re_ = tmp; } // swap kalau kebalik
            setRangeStart(String(rs)); setRangeEnd(String(re_));
          }
        }
      } catch { /* ignore */ }
      setRestored(true); // buka gerbang auto-load SETELAH filter terpasang
    })();
  }, []);

  // AUTO-LOAD: perubahan sumber deck (range / level / mode) langsung dimuat.
  // Debounce 300ms biar nggak kedip pas user masih ngetik angka.
  // SAAT DRAG SLIDER: load DITAHAN sampai tombol mouse dilepas (flush).
  const dragRef = useRef(false);
  const pendingRef = useRef(false);

  // gerbang: jangan load sebelum filter terakhir selesai di-restore
  useEffect(() => {
    if (!restored) return;
    const start = parseInt(rangeStart, 10) || 1;
    const end = parseInt(rangeEnd, 10) || 1;
    if (start < 1 || end < start) return; // setter sudah jaga; skip transisi tidak valid
    if (dragRef.current) { pendingRef.current = true; return; } // lagi di-drag — tunggu lepas
    const run = () => void loadDeck(start, end, kanjiMode, levelFilter);
    const t = window.setTimeout(run, 0);
    if (pendingRef.current) {
      // ada perubahan yang tertahan dari drag sebelumnya — muat langsung
      pendingRef.current = false;
      window.clearTimeout(t);
      run();
    }
    return () => window.clearTimeout(t);
  }, [restored, rangeStart, rangeEnd, kanjiMode, levelFilter]);

  // persist filter — DEBOUNCED 500ms biar nggak race saat drag cepat.
  // Tanpa ini, 10 panggilan setSetting bersamaan bisa selesai acak urutannya
  // (nilai lama nimpa nilai baru karena retry SQLite BUSY).
  const lastSavedRef = useRef<string>("");
  const prefsTimer = useRef<number | null>(null);
  const latestPrefs = useRef({ levelFilter, filter, rangeStart, rangeEnd, kanjiMode });
  latestPrefs.current = { levelFilter, filter, rangeStart, rangeEnd, kanjiMode };

  useEffect(() => {
    if (!restored) return;
    const next = JSON.stringify({ levelFilter, filter, rangeStart, rangeEnd, kanjiMode });
    if (next === lastSavedRef.current) return;
    console.log("[fc-prefs] antre:", next);
    // reset timer tiap perubahan — hanya tulis SETELAH 500ms nggak ada perubahan lagi
    if (prefsTimer.current) window.clearTimeout(prefsTimer.current);
    prefsTimer.current = window.setTimeout(() => {
      lastSavedRef.current = JSON.stringify(latestPrefs.current);
      console.log("[fc-prefs] TERSIMPAN:", lastSavedRef.current);
      void setSetting("flashcard_prefs", lastSavedRef.current);
    }, 500);
    return () => { if (prefsTimer.current) window.clearTimeout(prefsTimer.current); };
  }, [restored, levelFilter, filter, rangeStart, rangeEnd, kanjiMode]);

  // safety net: kalau user exit sebelum debounce selesai, simpan langsung nilai terakhir
  useEffect(() => {
    return () => {
      if (!lastSavedRef.current) return;
      const final = JSON.stringify(latestPrefs.current);
      if (final !== lastSavedRef.current) {
        console.log("[fc-prefs] flush on unmount:", final);
        void setSetting("flashcard_prefs", final);
      }
    };
  }, []);

  // dipanggil pas user melepas tombol mouse dari slider
  function flushPendingLoad() {
    dragRef.current = false;
    if (!pendingRef.current) return;
    pendingRef.current = false;
    const start = parseInt(rangeStart, 10) || 1;
    const end = parseInt(rangeEnd, 10) || 1;
    if (start >= 1 && end >= start) void loadDeck(start, end, kanjiMode, levelFilter);
  }

  useEffect(() => {
    if (autoPlay && c && !IS_MOBILE) {
      speak(kanjiMode && c.kanji && c.kanji !== "-" ? c.kanji : c.nihongo);
    }
  }, [idx, autoPlay]);

  const [contentW, setContentW] = useState(480);
  useEffect(() => {
    function onResize() {
      setContentW(window.innerWidth - 16);
    }
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function applyFilter(data: Kotoba[], f: "all" | "hafal" | "belum", useKanji: boolean) {
    const memField = useKanji ? "memorized_kanji" : "memorized";
    if (f === "hafal") return data.filter(c => c[memField] === 1);
    if (f === "belum") return data.filter(c => c[memField] === 0);
    return data;
  }

  async function loadDeck(start: number, end: number, useKanji: boolean, lvl: string = levelFilter) {
    setLoading(true);
    if (start < 1 || end < start) { setLoading(false); return; } // auto context: skip senyap
    const data = useKanji ? await getKanjiKotobaRange(start, end, lvl) : await getKotobaRange(start, end, lvl);
    setRawCards(data);
    setCards(applyFilter(data, filter, useKanji)); setIdx(0); setShowMeaning(false);
    setLoading(false);
  }

  async function onLevelChange(lvl: string) {
    setLevelFilter(lvl);
    let maxK = 0, maxJ = 0;
    if (lvl !== "all") {
      const [k, j] = await Promise.all([countKotobaByLevel(lvl), countKanjiByLevel(lvl)]);
      maxK = k; maxJ = j;
    }
    setLevelKanaCount(maxK); setLevelKanjiCount(maxJ);
    const m = lvl !== "all" ? (kanjiMode ? maxJ : maxK) : (kanjiMode ? kanjiTotal : total);
    const newEnd = Math.max(1, Math.min(20, m));
    // range di-clamp; auto-load effect yang memuat (bukan di sini)
    setRangeStart("1"); setRangeEnd(newEnd.toString());
  }

  function toggleFilter() {
    const next = filter === "all" ? "hafal" : filter === "hafal" ? "belum" : "all";
    setFilter(next);
    setCards(applyFilter(rawCards, next, kanjiMode));
    setIdx(0); setShowMeaning(false);
  }

  function shuffle() {
    const copy = [...rawCards];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    setRawCards(copy);
    setCards(applyFilter(copy, filter, kanjiMode)); setIdx(0); setShowMeaning(false);
  }

  function next() { if (idx < cards.length - 1) { setIdx(idx + 1); setShowMeaning(false); } }
  function prev() { if (idx > 0) { setIdx(idx - 1); setShowMeaning(false); } }

  async function handleHafal() {
    if (!c) return;
    const mode = kanjiMode ? "kanji" : "kana";
    const val = await toggleMemorized(c.id, mode);
    const rawIdx = rawCards.findIndex(r => r.id === c.id);
    if (rawIdx >= 0) {
      const updatedRaw = [...rawCards];
      if (kanjiMode) {
        updatedRaw[rawIdx] = { ...updatedRaw[rawIdx], memorized_kanji: val };
      } else {
        updatedRaw[rawIdx] = { ...updatedRaw[rawIdx], memorized: val };
      }
      setRawCards(updatedRaw);
      const filtered = applyFilter(updatedRaw, filter, kanjiMode);
      setCards(filtered);
      if (idx >= filtered.length) setIdx(Math.max(0, filtered.length - 1));
    }
    if (kanjiMode) {
      if (val) setHafalKanji(h => h + 1); else setHafalKanji(h => Math.max(0, h - 1));
    } else {
      if (val) setHafalKana(h => h + 1); else setHafalKana(h => Math.max(0, h - 1));
    }
  }

  const c = cards[idx];

  useLayoutEffect(() => {
    if (cardRef.current) cardRef.current.scrollTop = 0;
  }, [idx]);

  useEffect(() => {
    if (!showNav) return;
    function onMouseDown(e: MouseEvent) {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setShowNav(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [showNav]);

  const anim = "fadeCard 0.2s ease";

  // Max range: level-aware (dalam ruang level yang dipilih) vs total global
  const rangeMax = kanjiMode
    ? (levelFilter !== "all" ? levelKanjiCount : kanjiTotal)
    : (levelFilter !== "all" ? levelKanaCount : total);
  const sliderMax = Math.max(rangeMax, 100);

  const headerRight = (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-end" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", opacity: showTarget && (!kanaTarget || !kanjiTarget) ? 0.4 : 1 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "#39ff14", whiteSpace: "nowrap" }}>
          Kana: {hafalKana}/{showTarget ? (kanaTarget || "?") : total}
        </span>
        <div style={{ width: 70, height: 7, background: "rgba(255,255,255,0.08)", borderRadius: 4, overflow: "hidden" }}>
          <div style={{ width: `${showTarget ? (kanaTarget ? (hafalKana/kanaTarget)*100 : 0) : (total ? (hafalKana/total)*100 : 0)}%`, height: 7, background: "linear-gradient(90deg,#39ff14,#2adb10)", borderRadius: 4, transition: "width 0.3s" }} />
        </div>
        <span style={{ fontSize: 14, fontWeight: 600, color: "#4d94ff", whiteSpace: "nowrap" }}>
          Kanji: {hafalKanji}/{showTarget ? (kanjiTarget || "?") : kanjiTotal}
        </span>
        <div style={{ width: 70, height: 7, background: "rgba(255,255,255,0.08)", borderRadius: 4, overflow: "hidden" }}>
          <div style={{ width: `${showTarget ? (kanjiTarget ? (hafalKanji/kanjiTarget)*100 : 0) : (kanjiTotal ? (hafalKanji/kanjiTotal)*100 : 0)}%`, height: 7, background: "linear-gradient(90deg,#4d94ff,#3a7fff)", borderRadius: 4, transition: "width 0.3s" }} />
        </div>
        {showTarget && (!kanaTarget || !kanjiTarget) && (
          <span style={{ fontSize: 11, color: "#ffcc00" }}>Set target dulu!</span>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "#888", whiteSpace: "nowrap" }}>Progress:</span>
        <span onClick={() => setShowTarget(true)}
          style={{ cursor: "pointer", fontSize: 11, fontWeight: 700, color: showTarget ? "#ffcc00" : "#666", whiteSpace: "nowrap", padding: "2px 8px", borderRadius: 5, background: showTarget ? "rgba(255,204,0,0.15)" : "rgba(255,255,255,0.04)", border: showTarget ? "1px solid rgba(255,204,0,0.3)" : "1px solid transparent" }}>
          🎯 Target
        </span>
        <span onClick={() => setShowTarget(false)}
          style={{ cursor: "pointer", fontSize: 11, fontWeight: 700, color: !showTarget ? "#aaa" : "#666", whiteSpace: "nowrap", padding: "2px 8px", borderRadius: 5, background: !showTarget ? "rgba(255,255,255,0.06)" : "transparent", border: !showTarget ? "1px solid rgba(255,255,255,0.1)" : "1px solid transparent" }}>
          📊 Total
        </span>
      </div>
    </div>
  );

  return (
    <ScreenLayout onClose={onClose} logo={80} logoCentered headerRight={headerRight} width={contentW} fillHeight>
      <style>{`
        @keyframes fadeCard { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .text-gradient { background: linear-gradient(135deg, #4d94ff, #2fe6e6, #39ff14); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
        .dual-range { position: relative; flex: 1; min-width: 120px; height: 36px; }
        .dual-range input[type="range"] {
          position: absolute; width: 100%; top: 50%; transform: translateY(-50%);
          -webkit-appearance: none; appearance: none; background: none; pointer-events: none;
          margin: 0; padding: 0;
        }
        .dual-range input[type="range"]::-webkit-slider-runnable-track {
          height: 8px; border-radius: 4px;
          background: linear-gradient(90deg, rgba(57,255,20,0.15), rgba(77,148,255,0.15));
          box-shadow: 0 0 12px rgba(57,255,20,0.08), 0 0 12px rgba(77,148,255,0.08);
        }
        .dual-range input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none; width: 24px; height: 24px; border-radius: 50%;
          border: 2px solid #fff; cursor: pointer; pointer-events: auto;
          margin-top: -8px;
        }
        .dual-range input[type="range"]:first-child::-webkit-slider-thumb {
          background: linear-gradient(135deg, #39ff14, #1a9a0a);
          box-shadow: 0 0 16px rgba(57,255,20,0.6), 0 0 40px rgba(57,255,20,0.3);
        }
        .dual-range input[type="range"]:last-child::-webkit-slider-thumb {
          background: linear-gradient(135deg, #4d94ff, #1a4aff);
          box-shadow: 0 0 16px rgba(77,148,255,0.6), 0 0 40px rgba(77,148,255,0.3);
        }
        .dual-range input[type="range"]::-moz-range-track {
          height: 8px; border-radius: 4px;
          background: linear-gradient(90deg, rgba(57,255,20,0.15), rgba(77,148,255,0.15));
          box-shadow: 0 0 12px rgba(57,255,20,0.08), 0 0 12px rgba(77,148,255,0.08);
        }
        .dual-range input[type="range"]::-moz-range-thumb {
          width: 24px; height: 24px; border-radius: 50%;
          border: 2px solid #fff; cursor: pointer; pointer-events: auto;
        }
        .dual-range input[type="range"]:first-child::-moz-range-thumb {
          background: linear-gradient(135deg, #39ff14, #1a9a0a);
          box-shadow: 0 0 16px rgba(57,255,20,0.6), 0 0 40px rgba(57,255,20,0.3);
        }
        .dual-range input[type="range"]:last-child::-moz-range-thumb {
          background: linear-gradient(135deg, #4d94ff, #1a4aff);
          box-shadow: 0 0 16px rgba(77,148,255,0.6), 0 0 40px rgba(77,148,255,0.3);
        }
      `}</style>
      {loading ? <Spinner text="Memuat kartu..." full /> : (
        <div ref={contentRef} style={{ width: "100%", margin: "0 auto", display: "flex", flexDirection: "column", gap: 14, flex: 1 }}>
          {/* Subtitle + NAV row */}
          <div className="nf-section" style={{ color: "var(--cyan)", borderBottomColor: "rgba(47,230,230,0.3)", marginTop: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>🎴 FLASH CARD ⚡</span>
            <div ref={navRef} style={{ position: "relative" }}>
              <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":"#0a0a1a","--btn-bg2":"#445568","--btn-neon1":"#667799","--btn-neon2":"#445568","--btn-text":"#fff",fontSize:12,padding:"3px 12px"} as React.CSSProperties}
                onClick={() => setShowNav(!showNav)}>⚡ QUICK NAVIGATE ▼</button>
              {showNav && (
                <div style={{ position: "absolute", top: "100%", right: 0, zIndex: 100, marginTop: 4, background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: "4px 0", minWidth: 120, maxHeight: 300, overflowY: "auto", boxShadow: "0 8px 32px rgba(0,0,0,0.5)" }}>
                  {(() => {
                    const max = rangeMax;
                    const ck: { start: number; end: number }[] = [];
                    for (let i = 0; i < max; i += 100) {
                      ck.push({ start: i + 1, end: Math.min(i + 100, max) });
                    }
                    const active = ck.findIndex(x => x.start === (parseInt(rangeStart, 10) || 1) && x.end === (parseInt(rangeEnd, 10) || 1));
                    return ck.map((ch, i) => (
                      <div key={i} onClick={() => { setRangeStart(ch.start.toString()); setRangeEnd(ch.end.toString()); setShowNav(false); }}
                        style={{ padding: "6px 14px", cursor: "pointer", fontSize: 13, color: active === i ? "#ffcc00" : "#ccc", background: active === i ? "rgba(255,204,0,0.08)" : "transparent", fontWeight: active === i ? 700 : 400, whiteSpace: "nowrap" }}
                        onMouseEnter={(e) => { if (active !== i) e.currentTarget.style.background = "rgba(255,255,255,0.05)"; }}
                        onMouseLeave={(e) => { if (active !== i) e.currentTarget.style.background = "transparent"; }}>
                        {ch.start}-{ch.end}
                      </div>
                    ));
                  })()}
                </div>
              )}
            </div>
          </div>

          {/* ===== BOX: SUMBER DECK (semua perubahan auto-load) ===== */}
          <div style={{ border: "1px solid rgba(47,230,230,0.18)", borderRadius: 12, background: "rgba(47,230,230,0.04)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px 0", flexWrap: "wrap", gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, color: "#2fe6e6" }}>📦 SUMBER DECK — berubah = otomatis dimuat</span>
              <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":"#100520","--btn-bg2":"#9a3dff","--btn-neon1":"#b86aff","--btn-neon2":"#9a3dff","--btn-text":"#fff",fontSize:14,padding:"5px 14px"} as React.CSSProperties}
                onClick={() => setKanjiMode(!kanjiMode)}>{kanjiMode ? "漢字 Mode Kanji" : "かな Normal"}</button>
            </div>
            {/* RANGE row */}
            <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 16px 8px" }}>
              <span className="text-gradient" style={{ fontSize: 16, fontWeight: 800, letterSpacing: 1 }}>RANGE</span>
              <input type="number" value={rangeStart} onChange={e => { const v = e.target.value; if (v === "") { setRangeStart(""); return; } const n = parseInt(v, 10); if (!isNaN(n)) { setRangeStart(n.toString()); if (n > (parseInt(rangeEnd, 10) || n)) setRangeEnd(n.toString()); } }}
                style={{ width: 85, padding: "6px 10px", fontSize: 18, background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, color: "#fff", textAlign: "center" }} />
              <span style={{ color: "#555", fontSize: 24, fontWeight: 300 }}>—</span>
              <div className="dual-range">
                {/* ijo (start): boleh mendorong biru kalau lewat */}
                <input type="range" min={1} max={sliderMax} value={parseInt(rangeStart, 10) || 1}
                  onPointerDown={() => { dragRef.current = true; }}
                  onPointerUp={flushPendingLoad}
                  onPointerCancel={() => { dragRef.current = false; pendingRef.current = false; }}
                  onChange={(e) => { const v = Number(e.target.value); setRangeStart(v.toString()); if (v > (parseInt(rangeEnd, 10) || v)) setRangeEnd(v.toString()); }} />
                {/* biru (end): boleh mendorong ijo kalau kurang */}
                <input type="range" min={1} max={sliderMax} value={parseInt(rangeEnd, 10) || 1}
                  onPointerDown={() => { dragRef.current = true; }}
                  onPointerUp={flushPendingLoad}
                  onPointerCancel={() => { dragRef.current = false; pendingRef.current = false; }}
                  onChange={(e) => { const v = Number(e.target.value); setRangeEnd(v.toString()); if (v < (parseInt(rangeStart, 10) || v)) setRangeStart(v.toString()); }} />
              </div>
              <span style={{ color: "#fff", fontSize: 20, fontWeight: "bold", minWidth: 50, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
                {rangeEnd}
              </span>
              <span style={{ fontSize: 13, color: "#888", whiteSpace: "nowrap" }}>
                {levelFilter !== "all" ? `(level ${levelFilter}: ${rangeMax})` : `(total: ${rangeMax})`}
              </span>
              <input type="number" value={rangeEnd} onChange={e => { const v = e.target.value; if (v === "") { setRangeEnd(""); return; } const n = parseInt(v, 10); if (!isNaN(n)) { setRangeEnd(n.toString()); if (n < (parseInt(rangeStart, 10) || n)) setRangeStart(n.toString()); } }}
                style={{ width: 85, padding: "6px 10px", fontSize: 18, background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, color: "#fff", textAlign: "center" }} />
            </div>
            <div style={{ height: 1, background: "rgba(255,255,255,0.05)", margin: "0 16px" }} />
            {/* LEVEL row */}
            <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 16px 12px" }}>
              <span className="text-gradient" style={{ fontSize: 15, fontWeight: 800, letterSpacing: 1 }}>LEVEL</span>
              <LevelFilter value={levelFilter} compact onChange={onLevelChange} />
            </div>
          </div>

          {/* ===== BOX: TAMPILAN (live, tanpa muat ulang) ===== */}
          <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, background: "rgba(255,255,255,0.02)" }}>
            <div style={{ padding: "10px 16px 0", fontSize: 11, fontWeight: 800, letterSpacing: 1, color: "#888" }}>🎨 TAMPILAN — langsung aktif tanpa muat ulang</div>
            <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 16px 12px", flexWrap: "wrap" }}>
              <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":"#150500","--btn-bg2":"#ff6b35","--btn-neon1":"#ff8c5a","--btn-neon2":"#ff6b35","--btn-text":"#fff",fontSize:18,padding:"8px 18px"} as React.CSSProperties}
                onClick={() => { setReverseMode(!reverseMode); }}>{reverseMode ? "Jepang→Indonesia" : "Indonesia→Jepang"}</button>
              <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":"#001015","--btn-bg2":"#1ac8c8","--btn-neon1":"#3aebeb","--btn-neon2":"#1ac8c8","--btn-text":"#fff",fontSize:18,padding:"8px 18px"} as React.CSSProperties}
                onClick={shuffle}>🔀 Shuffle</button>
              <button className="nf-btn nf-btn-neon" style={{"--btn-bg1": autoPlay ? "#002010" : "#150800","--btn-bg2": autoPlay ? "#2adb10" : "#663322","--btn-neon1": autoPlay ? "#3aeb20" : "#885544","--btn-neon2": autoPlay ? "#2adb10" : "#663322","--btn-text": autoPlay ? "#000" : "#bba090",fontSize:18,padding:"8px 18px"} as React.CSSProperties}
                onClick={() => setAutoPlay(!autoPlay)}>🔊 {autoPlay ? "AUTO" : "Mute"}</button>
              <button className="nf-btn nf-btn-neon" style={filter === "all" ? {"--btn-bg1":"#0a0a0a","--btn-bg2":"#3a3a4a","--btn-neon1":"#5a5a6a","--btn-neon2":"#3a3a4a","--btn-text":"#bbb",fontSize:16,padding:"8px 14px"} as React.CSSProperties : filter === "hafal" ? {"--btn-bg1":"#002010","--btn-bg2":"#2adb10","--btn-neon1":"#3aeb20","--btn-neon2":"#2adb10","--btn-text":"#000",fontSize:16,padding:"8px 14px"} as React.CSSProperties : {"--btn-bg1":"#1a0800","--btn-bg2":"#cc6600","--btn-neon1":"#ff8833","--btn-neon2":"#cc6600","--btn-text":"#fff",fontSize:16,padding:"8px 14px"} as React.CSSProperties}
                onClick={toggleFilter}>{filter === "all" ? "📋 Semua" : filter === "hafal" ? "✅ Hafal" : "⬜ Belum"}</button>
              <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":"#151000","--btn-bg2":"#ccaa00","--btn-neon1":"#ffdd44","--btn-neon2":"#ccaa00","--btn-text":"#000",fontSize:16,padding:"8px 14px"} as React.CSSProperties}
                onClick={() => { setEditKanaTarget(kanaTarget); setEditKanjiTarget(kanjiTarget); setShowTargetInput(true); }}>🎯 Set</button>
              <div style={{ flex: 1 }} />
              <span style={{ color: "#aaa", fontSize: 18, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                {cards.length > 0 ? `${idx + 1}/${cards.length}` : "0/0"}
              </span>
            </div>
          </div>

          {/* Target input modal */}
          {showTargetInput && (
            <div style={{ padding: "16px 20px", background: "rgba(0,20,15,0.9)", border: "1px solid rgba(255,204,0,0.3)", borderRadius: 12 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#ffcc00", marginBottom: 12 }}>🎯 SET TARGET HAFALAN</div>
              <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ color: "#39ff14", fontSize: 14, fontWeight: 600 }}>Kana:</span>
                  <input type="number" value={editKanaTarget} onChange={(e) => setEditKanaTarget(Math.max(0, Number(e.target.value)))}
                    style={{ width: 100, padding: "6px 10px", fontSize: 16, background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, color: "#39ff14", textAlign: "center" }} />
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ color: "#4d94ff", fontSize: 14, fontWeight: 600 }}>Kanji:</span>
                  <input type="number" value={editKanjiTarget} onChange={(e) => setEditKanjiTarget(Math.max(0, Number(e.target.value)))}
                    style={{ width: 100, padding: "6px 10px", fontSize: 16, background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, color: "#4d94ff", textAlign: "center" }} />
                </div>
                <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":"#002010","--btn-bg2":"#2adb10","--btn-neon1":"#3aeb20","--btn-neon2":"#2adb10","--btn-text":"#000",fontSize:16,padding:"8px 22px"} as React.CSSProperties}
                  onClick={async () => {
                    await setTarget("kana", editKanaTarget);
                    await setTarget("kanji", editKanjiTarget);
                    setKanaTarget(editKanaTarget); setKanjiTarget(editKanjiTarget);
                    setShowTargetInput(false);
                  }}>💾 Simpan</button>
                <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":"#0a0a0a","--btn-bg2":"#3a3a4a","--btn-neon1":"#5a5a6a","--btn-neon2":"#3a3a4a","--btn-text":"#bbb",fontSize:16,padding:"8px 18px"} as React.CSSProperties}
                  onClick={() => setShowTargetInput(false)}>Batal</button>
              </div>
            </div>
          )}

          {/* Card / Empty state */}
          {c ? (
            <div ref={cardRef} style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column", gap: 14, overflow: "auto" }}>
              {c && !IS_MOBILE && (
                <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":"#002010","--btn-bg2":"#2adb10","--btn-neon1":"#3aeb20","--btn-neon2":"#2adb10","--btn-text":"#000",fontSize:15,padding:"6px 14px",position:"absolute",top:8,left:8,zIndex:10} as React.CSSProperties}
                  onClick={(e) => { e.stopPropagation(); speak(kanjiMode && c.kanji && c.kanji !== "-" ? c.kanji : c.nihongo); }}>🔊 SUARA</button>
              )}
              <div key={`${idx}-${showMeaning}`} style={{ animation: anim, flex: 1, display: "flex", flexDirection: "column" }}>
                {!showMeaning ? (
                  /* FRONT */
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", borderRadius: 16, padding: 14, background: "rgba(255,255,255,0.03)", cursor: "pointer", minHeight: 110, position: "relative" }}
                    onClick={() => setShowMeaning(true)}>
                    {c.level && (
                      <div style={{ position: "absolute", top: 12, right: 12, fontSize: 10, fontWeight: 700, color: "#ffdd44", background: "rgba(255,221,68,0.1)", border: "1px solid rgba(255,221,68,0.3)", borderRadius: 999, padding: "2px 10px" }}>{c.level}</div>
                    )}
                    <div style={{
                      fontSize: reverseMode ? rightFont : leftFont,
                      fontWeight: "bold", color: "#fff", textAlign: "center", wordBreak: "break-all",
                      lineHeight: 1.3, textShadow: "0 0 20px rgba(255,255,255,0.1)",
                    }}>
                      {reverseMode ? c.imi : (kanjiMode && c.kanji && c.kanji !== "-" ? c.kanji : c.nihongo)}
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                      <button onClick={(e) => { e.stopPropagation(); setLeftFont(Math.max(0, FONT_SIZES.indexOf(leftFont) - 1) >= 0 ? FONT_SIZES[Math.max(0, FONT_SIZES.indexOf(leftFont) - 1)] : leftFont); }}
                        style={{ background: "rgba(255,255,255,0.05)", border: "1px solid #444", borderRadius: 4, color: "#aaa", cursor: "pointer", padding: "4px 14px", fontSize: 14 }}>A−</button>
                      <span style={{ color: "#666", fontSize: 14, alignSelf: "center" }}>{leftFont}px</span>
                      <button onClick={(e) => { e.stopPropagation(); setLeftFont(Math.min(FONT_SIZES.length - 1, FONT_SIZES.indexOf(leftFont) + 1) < FONT_SIZES.length ? FONT_SIZES[Math.min(FONT_SIZES.length - 1, FONT_SIZES.indexOf(leftFont) + 1)] : leftFont); }}
                        style={{ background: "rgba(255,255,255,0.05)", border: "1px solid #444", borderRadius: 4, color: "#aaa", cursor: "pointer", padding: "4px 14px", fontSize: 14 }}>A+</button>
                    </div>
                    <div style={{ marginTop: 18, fontSize: 13, color: "#555" }}>Klik atau tekan Spasi</div>
                  </div>
                ) : (
                  /* BACK */
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", borderRadius: 16, padding: 14, background: "rgba(255,255,255,0.05)", cursor: "pointer", minHeight: 110 }}
                    onClick={() => setShowMeaning(false)}>
                    <div style={{ fontSize: reverseMode ? leftFont : rightFont, fontWeight: "bold", color: "var(--cyan)", textAlign: "center", wordBreak: "break-all", lineHeight: 1.3, textShadow: "0 0 10px rgba(47,230,230,0.3)" }}>
                      {reverseMode ? ((kanjiMode && c.kanji && c.kanji !== "-" ? c.kanji : c.nihongo)) : c.imi}
                    </div>
                    {kanjiMode && c.nihongo ? (
                      <div style={{ marginTop: 10, fontSize: 22, color: "#aaa" }}>
                        Kana: <span style={{ color: "#fff" }}>{c.nihongo}</span>
                      </div>
                    ) : c.kanji && c.kanji !== "-" && (
                      <div style={{ marginTop: 10, fontSize: 22, color: "#aaa" }}>
                        Kanji: <span style={{ color: "#fff" }}>{c.kanji}</span>
                      </div>
                    )}
                    {c.explanation && c.explanation !== "-" && (
                      <div style={{ marginTop: 10, fontSize: 15, color: "#999", fontStyle: "italic", whiteSpace: "pre-wrap", padding: "0 16px", textAlign: "center" }}>
                        {c.explanation}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
                      <button onClick={(e) => { e.stopPropagation(); setRightFont(Math.max(0, FONT_SIZES.indexOf(rightFont) - 1) >= 0 ? FONT_SIZES[Math.max(0, FONT_SIZES.indexOf(rightFont) - 1)] : rightFont); }}
                        style={{ background: "rgba(255,255,255,0.05)", border: "1px solid #444", borderRadius: 4, color: "#aaa", cursor: "pointer", padding: "4px 14px", fontSize: 14 }}>A−</button>
                      <span style={{ color: "#666", fontSize: 14 }}>{rightFont}px</span>
                      <button onClick={(e) => { e.stopPropagation(); setRightFont(Math.min(FONT_SIZES.length - 1, FONT_SIZES.indexOf(rightFont) + 1) < FONT_SIZES.length ? FONT_SIZES[Math.min(FONT_SIZES.length - 1, FONT_SIZES.indexOf(rightFont) + 1)] : rightFont); }}
                        style={{ background: "rgba(255,255,255,0.05)", border: "1px solid #444", borderRadius: 4, color: "#aaa", cursor: "pointer", padding: "4px 14px", fontSize: 14 }}>A+</button>
                    </div>
                  </div>
                )}
              </div>

              {/* Action row */}
              <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, maxWidth: 150 }}>
                  <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":"#0a0a1a","--btn-bg2":"#445568","--btn-neon1":"#667799","--btn-neon2":"#445568","--btn-text":"#fff",fontSize:16,width:"100%",padding:"8px 0"} as React.CSSProperties}
                    onClick={prev} disabled={idx === 0}>◀ PREV</button>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#5a9fff", textShadow: "0 0 8px rgba(90,159,255,0.6), 0 0 20px rgba(90,159,255,0.3)", marginTop: 4 }}>←</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, maxWidth: 150 }}>
                  <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":"#1a0510","--btn-bg2":"#e02050","--btn-neon1":"#ff5a7a","--btn-neon2":"#e02050","--btn-text":"#fff",fontSize:16,width:"100%",padding:"8px 0"} as React.CSSProperties}
                    onClick={(e) => { e.stopPropagation(); setShowMeaning(!showMeaning); }}>{showMeaning ? "🎴 TUTUP" : "🎴 LIHAT ARTI"}</button>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#ff5a7a", textShadow: "0 0 8px rgba(255,90,122,0.6), 0 0 20px rgba(255,90,122,0.3)", marginTop: 4 }}>Spasi</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, maxWidth: 150 }}>
                  <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":"#000d1a","--btn-bg2":"#3a7fff","--btn-neon1":"#5a9fff","--btn-neon2":"#3a7fff","--btn-text":"#fff",fontSize:16,width:"100%",padding:"8px 0"} as React.CSSProperties}
                    onClick={next} disabled={idx === cards.length - 1}>NEXT ▶</button>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#4d94ff", textShadow: "0 0 8px rgba(77,148,255,0.6), 0 0 20px rgba(77,148,255,0.3)", marginTop: 4 }}>→</span>
                </div>
              </div>

              {/* Hafal toggle */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <button className="nf-btn nf-btn-neon" style={(kanjiMode ? c.memorized_kanji : c.memorized) ? {"--btn-bg1":"#002010","--btn-bg2":"#2adb10","--btn-neon1":"#3aeb20","--btn-neon2":"#2adb10","--btn-text":"#000",fontSize:15,padding:"8px 20px"} as React.CSSProperties : {"--btn-bg1":"#0a0a0a","--btn-bg2":"#3a5544","--btn-neon1":"#557766","--btn-neon2":"#3a5544","--btn-text":"#8aaa99",fontSize:15,padding:"8px 20px"} as React.CSSProperties}
                  onClick={handleHafal}>
                  {(kanjiMode ? c.memorized_kanji : c.memorized) ? "✅ SUDAH HAFAL" : "⬜ TANDAI HAFAL"}
                </button>
                <span style={{ fontSize: 14, fontWeight: 700, color: "#5a9fff", textShadow: "0 0 8px rgba(90,159,255,0.6), 0 0 20px rgba(90,159,255,0.3)" }}>Enter</span>
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12 }}>
              <div style={{ fontSize: 48, opacity: 0.3 }}>{filter === "hafal" ? "✅" : "⬜"}</div>
              <div style={{ fontSize: 18, color: "#888", textAlign: "center" }}>
                {rawCards.length === 0 ? "Belum ada kartu untuk pengaturan ini." :
                 levelFilter !== "all" ? `Tidak ada kata level ${levelFilter} di range ini.` :
                 filter === "hafal" ? "Belum ada yang dihafal di range ini." :
                 filter === "belum" ? "Semua sudah dihafal di range ini!" : ""}
              </div>
              {filter !== "all" && (
                <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":"#0a0a0a","--btn-bg2":"#3a3a4a","--btn-neon1":"#5a5a6a","--btn-neon2":"#3a3a4a","--btn-text":"#bbb",fontSize:16,padding:"8px 22px"} as React.CSSProperties}
                  onClick={() => { setFilter("all"); setCards(applyFilter(rawCards, "all", kanjiMode)); setIdx(0); setShowMeaning(false); }}>Tampilkan Semua</button>
              )}
              {filter === "all" && levelFilter !== "all" && (
                <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":"#0a0a0a","--btn-bg2":"#3a3a4a","--btn-neon1":"#5a5a6a","--btn-neon2":"#3a3a4a","--btn-text":"#bbb",fontSize:16,padding:"8px 22px"} as React.CSSProperties}
                  onClick={() => onLevelChange("all")}>Ganti ke Semua Level</button>
              )}
            </div>
          )}
        </div>
        )}
    </ScreenLayout>
  );
}
