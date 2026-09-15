import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { countKanji, countKanjiByLevel, getKanjiForTest, getLastKanjiProgress, saveHistory, recordWrongWord, getDb } from "./db";
import { checkAnswer } from "./scoring";
import { useConfirm, useAlert } from "./Modal";
import ScreenLayout from "./ScreenLayout";
import LevelFilter from "./LevelFilter";
import Spinner from "./Spinner";

interface KanjiTestProps { onClose: () => void; }
type Mode = "artiOnly" | "kanaOnly" | "artiKana";
type MemFilter = "all" | "memorized" | "not_memorized";

// Auto-switch keyboard layout Windows saat field jawaban difokuskan.
// Layout harus ter-install di OS; kalau tidak, command Rust no-op diam-diam.
function setKB(layout: "en" | "ja") {
  invoke("set_keyboard_layout", { layout }).catch(() => { /* no-op */ });
}

interface Q { kanji: string; imi: string; nihongo: string; rowid: number; memorized: number; user: string; userImi?: string; userKana?: string; status: "" | "BENAR" | "SALAH"; }
interface SavedProgress { questions: Q[]; index: number; mode: Mode; correct: number; wrong: number; startNo: number; endNo: number; }

const PROGRESS_KEY = "kanji_progress";

function normAns(s: string): string {
  return (s || "").replace(/\s+/g, "").trim();
}

// Kana benar jika cocok SALAH SATU varian bacaan dari kolom nihongo
// (nihongo bisa multi-reading dipisah spasi / / , 、)
function kanaMatch(userKana: string, nihongo: string): boolean {
  const u = normAns(userKana);
  if (!u) return false;
  const variants = (nihongo || "")
    .split(/[\/、,，]+|\s+/)
    .map((v) => normAns(v))
    .filter(Boolean);
  if (variants.length === 0) return u === normAns(nihongo);
  return variants.includes(u);
}

export default function KanjiTest({ onClose }: KanjiTestProps) {
  const confirm = useConfirm();
  const alert = useAlert();

  const [maxItems, setMaxItems] = useState(0);
  const [mode, setMode] = useState<Mode>("artiOnly");
  const [startNo, setStartNo] = useState("1");
  const [endNo, setEndNo] = useState("20");
  const [lastProgress, setLastProgress] = useState("");
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [memFilter, setMemFilter] = useState<MemFilter>("all");
  const [questions, setQuestions] = useState<Q[]>([]);
  const [index, setIndex] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [wrong, setWrong] = useState(0);
  const [answer, setAnswer] = useState("");
  const [kanaAnswer, setKanaAnswer] = useState("");
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean; jawaban: string } | null>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const [answered, setAnswered] = useState(false);
  const [finished, setFinished] = useState(false);
  useEffect(() => { if (answered && feedback) feedbackRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [answered, feedback]);

  const saveProgress = useCallback(async (p: SavedProgress) => {
    const db = await getDb();
    await db.execute("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2", [PROGRESS_KEY, JSON.stringify(p)]);
  }, []);

  const clearProgress = useCallback(async () => {
    const db = await getDb();
    await db.execute("DELETE FROM settings WHERE key = $1", [PROGRESS_KEY]);
  }, []);

  useEffect(() => {
    (async () => {
      const total = await countKanji();
      setMaxItems(total);
      setEndNo(Math.min(20, total).toString());
      const last = await getLastKanjiProgress();
      if (last) setLastProgress(`Progress terakhir: Kanji ke-${last.endRange} (Skor: ${last.skor}%)`);
      else setLastProgress("Belum ada data Kanji.");
      const db = await getDb();
      const rows = await db.select<{ value: string }[]>("SELECT value FROM settings WHERE key = $1", [PROGRESS_KEY]);
      if (rows.length > 0) {
        try {
          // mode legacy "JtoI"/"ItoJ" di-map ke penamaan baru
          const p = JSON.parse(rows[0].value) as Omit<SavedProgress, "mode"> & { mode?: string };
          if (p.questions && p.index < p.questions.length) {
            setQuestions(p.questions); setIndex(p.index);
            setMode(
              p.mode === "ItoJ" || p.mode === "artiKana"
                ? "artiKana"
                : p.mode === "kanaOnly"
                  ? "kanaOnly"
                  : "artiOnly"
            );
            setCorrect(p.correct); setWrong(p.wrong); setStartNo(p.startNo.toString()); setEndNo(p.endNo.toString());
            setActive(true);
          }
        } catch { /* ignore */ }
      }
    })();
  }, []);

  function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  async function onLevelChange(lvl: string) {
    setLevelFilter(lvl);
    const newMax = lvl === "all" ? await countKanji() : await countKanjiByLevel(lvl);
    setMaxItems(newMax);
    const curEnd = parseInt(endNo, 10) || 0;
    if (curEnd > newMax) setEndNo(String(newMax));
    const curStart = parseInt(startNo, 10) || 0;
    if (curStart > newMax) setStartNo("1");
  }

  async function startTest() {
    const sn = parseInt(startNo, 10) || 0, en = parseInt(endNo, 10) || 0;
    if (sn < 1 || en < sn || en > maxItems) { await alert(`Range tidak valid! (1 sampai ${maxItems})`); return; }
    const lvlTxt = levelFilter === "all" ? "" : ` level ${levelFilter}`;
    const filterLabel = memFilter === "memorized" ? "sudah hafal" : memFilter === "not_memorized" ? "belum hafal" : "";
    const ok = await confirm(`Mulai test ${filterLabel}${lvlTxt} kanji ke-${sn} s/d ${en}?\nProgress batch ini akan dihapus.`);
    if (!ok) return;
    await doLoad(memFilter);
  }

  async function doLoad(filter: MemFilter) {
    const sn = parseInt(startNo, 10) || 1, en = parseInt(endNo, 10) || 1;
    const requested = en - sn + 1;
    setLoading(true);
    try {
      const raw = await getKanjiForTest(sn, en, filter, levelFilter);
      if (raw.length === 0) {
        const lvlTxt = levelFilter === "all" ? "" : ` level ${levelFilter}`;
        await alert(`Tidak ada kanji${lvlTxt} di range ${sn}-${en}. Coba ubah range atau level!`);
        return;
      }
      if (raw.length < requested) {
        const lvlTxt = levelFilter === "all" ? "" : ` level ${levelFilter}`;
        await alert(`Hanya ${raw.length} kanji${lvlTxt} ditemukan di range ${sn}-${en} (dari ${requested} yang diminta). Sisa akan dilompati.`);
      }
      const qs: Q[] = shuffle(raw).map(r => ({ kanji: r.kanji, imi: r.imi, nihongo: r.nihongo, rowid: r.rowid, memorized: r.memorized, user: "", status: "" }));
      setQuestions(qs); setIndex(0); setCorrect(0); setWrong(0);
      setActive(true); setFinished(false); setFeedback(null); setAnswered(false); setAnswer(""); setKanaAnswer("");
      await saveProgress({ questions: qs, index: 0, mode, correct: 0, wrong: 0, startNo: sn, endNo: en });
    } finally {
      setLoading(false);
    }
  }

  const current = questions[index];
  // kedua mode selalu menampilkan kanji besar
  const soalText = current ? current.kanji : "";
  const pct = questions.length ? Math.round(((index + 1) / questions.length) * 100) : 0;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Enter" || e.shiftKey) return;
      // abaikan Enter dari IME (konfirmasi konversi kana → jangan hitung jawaban)
      if (e.isComposing || e.keyCode === 229) return;
      if (!active || !current) return;
      e.preventDefault();
      if (!answered) cek(); else next();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, current, answered, answer, kanaAnswer, index, questions, correct, wrong, mode]);

  async function cek() {
    if (!current) return;
    if (answered) return; // guard dobel-hitung (Enter ganda cepat)
    const newQ = [...questions];
    let isCorrect: boolean;
    let correctAnswerDisplay: string;
    let feedbackText: string;
    if (mode === "artiOnly") {
      if (!answer.trim()) { await alert("Jawaban tidak boleh kosong!"); return; }
      isCorrect = checkAnswer(answer, current.imi);
      correctAnswerDisplay = current.imi;
      feedbackText = isCorrect ? "BENAR!" : "SALAH!";
      newQ[index] = { ...current, user: answer.trim(), status: isCorrect ? "BENAR" : "SALAH" };
    } else if (mode === "kanaOnly") {
      if (!kanaAnswer.trim()) { await alert("Jawaban tidak boleh kosong!"); return; }
      isCorrect = kanaMatch(kanaAnswer, current.nihongo);
      correctAnswerDisplay = current.nihongo;
      feedbackText = isCorrect ? "BENAR!" : "SALAH!";
      newQ[index] = { ...current, userKana: kanaAnswer.trim(), status: isCorrect ? "BENAR" : "SALAH" };
    } else {
      if (!answer.trim() || !kanaAnswer.trim()) { await alert("Isi kedua jawaban (Arti & Kana)!"); return; }
      const imiOk = checkAnswer(answer, current.imi);
      const kanaOk = kanaMatch(kanaAnswer, current.nihongo);
      isCorrect = imiOk && kanaOk;
      correctAnswerDisplay = `${current.imi} · ${current.nihongo}`;
      feedbackText = isCorrect
        ? "BENAR!"
        : `SALAH! (${imiOk ? "Arti ✅" : "Arti ❌"} · ${kanaOk ? "Kana ✅" : "Kana ❌"})`;
      newQ[index] = { ...current, userImi: answer.trim(), userKana: kanaAnswer.trim(), status: isCorrect ? "BENAR" : "SALAH" };
    }
    setQuestions(newQ);
    let nc = correct, nw = wrong;
    if (isCorrect) { nc++; setCorrect(nc); setFeedback({ text: feedbackText, ok: true, jawaban: correctAnswerDisplay }); }
    else { nw++; setWrong(nw); setFeedback({ text: feedbackText, ok: false, jawaban: correctAnswerDisplay }); await recordWrongWord(current.kanji); }
    setAnswered(true);
    await saveProgress({ questions: newQ, index, mode, correct: nc, wrong: nw, startNo: parseInt(startNo, 10) || 1, endNo: parseInt(endNo, 10) || 1 });
  }

  async function next() {
    const isLast = index === questions.length - 1;
    if (isLast) { await finish(); return; }
    const ni = index + 1;
    setIndex(ni); setAnswer(""); setKanaAnswer(""); setFeedback(null); setAnswered(false);
    await saveProgress({ questions, index: ni, mode, correct, wrong, startNo: parseInt(startNo, 10) || 1, endNo: parseInt(endNo, 10) || 1 });
  }

  async function finish() {
    const skor = questions.length > 0 ? Math.round((correct / questions.length) * 100) : 0;
    await saveHistory(`${startNo}-${endNo}`, skor, "Kanji");
    await clearProgress();
    setFinished(true);
  }

  async function resetProgress() {
    const ok = await confirm("Hapus progress & kembali ke awal?");
    if (!ok) return;
    await clearProgress();
    setActive(false); setQuestions([]); setIndex(0); setCorrect(0); setWrong(0);
    setFeedback(null); setAnswered(false); setFinished(false); setAnswer(""); setKanaAnswer("");
  }

  async function switchMode(newMode: Mode) {
    if (active) {
      const ok = await confirm("Switch mode akan mereset score progress sesi ini. Lanjutkan?");
      if (!ok) return;
      setIndex(0); setCorrect(0); setWrong(0); setFeedback(null); setAnswered(false); setAnswer(""); setKanaAnswer("");
      await saveProgress({ questions, index: 0, mode: newMode, correct: 0, wrong: 0, startNo: parseInt(startNo, 10) || 1, endNo: parseInt(endNo, 10) || 1 });
    }
    setMode(newMode);
  }

  const [contentW, setContentW] = useState(480);
  useEffect(() => {
    function onResize() { setContentW(window.innerWidth - 16); }
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const sliderMax = Math.max(maxItems, 100);

  const headerRight = (
    <span style={{ fontSize: 14, color: "#555", whiteSpace: "nowrap" }}>{lastProgress}</span>
  );

  if (finished) return <ResultScreen questions={questions} correct={correct} wrong={wrong}
    onRetry={() => { setFinished(false); setActive(false); setQuestions([]); setIndex(0); setCorrect(0); setWrong(0); setAnswer(""); setFeedback(null); setAnswered(false); }}
    onClose={onClose} />;

  if (loading) return (
    <ScreenLayout subtitle="漢 KANJI TEST ⚡" onClose={onClose} logo={80} logoCentered headerRight={headerRight} width={contentW} fillHeight>
      <Spinner text="Memuat soal..." full />
    </ScreenLayout>
  );

  const inputStyle: React.CSSProperties = { width: 85, padding: "6px 10px", fontSize: 18, background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, color: "#fff", textAlign: "center" };

  return (
    <ScreenLayout subtitle="漢 KANJI TEST ⚡" onClose={onClose} logo={80} logoCentered headerRight={headerRight} width={contentW} fillHeight>
      <style>{`
        @keyframes fadeCard { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .text-gradient { background: linear-gradient(135deg, #4d94ff, #2fe6e6, #39ff14); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
        .dual-range { position: relative; flex: 1; min-width: 140px; height: 36px; }
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

      {/* Settings row */}
      {!active && (
      <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 16px", background: "rgba(255,255,255,0.03)", borderRadius: 10, flexWrap: "wrap" }}>
        <span className="text-gradient" style={{ fontSize: 16, fontWeight: 800, letterSpacing: 1 }}>MODE</span>
        <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":mode==="artiOnly"?"#100520":"#1a1a2e","--btn-bg2":mode==="artiOnly"?"#9a3dff":"#2a2a3e","--btn-neon1":mode==="artiOnly"?"#b86aff":"#3a3a5e","--btn-neon2":mode==="artiOnly"?"#9a3dff":"#2a2a3e","--btn-text":mode==="artiOnly"?"#fff":"#666",fontSize:15,padding:"8px 14px"} as React.CSSProperties}
          onClick={() => switchMode("artiOnly")}>Hanya Arti</button>
        <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":mode==="kanaOnly"?"#100520":"#1a1a2e","--btn-bg2":mode==="kanaOnly"?"#9a3dff":"#2a2a3e","--btn-neon1":mode==="kanaOnly"?"#b86aff":"#3a3a5e","--btn-neon2":mode==="kanaOnly"?"#9a3dff":"#2a2a3e","--btn-text":mode==="kanaOnly"?"#fff":"#666",fontSize:15,padding:"8px 14px"} as React.CSSProperties}
          onClick={() => switchMode("kanaOnly")}>Hanya Kana</button>
        <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":mode==="artiKana"?"#100520":"#1a1a2e","--btn-bg2":mode==="artiKana"?"#9a3dff":"#2a2a3e","--btn-neon1":mode==="artiKana"?"#b86aff":"#3a3a5e","--btn-neon2":mode==="artiKana"?"#9a3dff":"#2a2a3e","--btn-text":mode==="artiKana"?"#fff":"#666",fontSize:15,padding:"8px 14px"} as React.CSSProperties}
          onClick={() => switchMode("artiKana")}>Arti + Kana</button>
      </div>
      )}

      {/* Level filter row */}
      {!active && (
      <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 16px", background: "rgba(255,255,255,0.03)", borderRadius: 10, marginTop: 10 }}>
        <span className="text-gradient" style={{ fontSize: 16, fontWeight: 800, letterSpacing: 1 }}>LEVEL</span>
        <LevelFilter value={levelFilter} onChange={onLevelChange} compact />
        <span style={{ fontSize: 13, color: "#4d94ff", textShadow: "0 0 8px rgba(77,148,255,0.3)" }}>
          {levelFilter === "all" ? `Semua: ${maxItems} kanji` : `Level ${levelFilter}: ${maxItems} kanji`}
        </span>
      </div>
      )}

      {/* Range + MemFilter + START row */}
      {!active && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "12px 16px", background: "rgba(255,255,255,0.03)", borderRadius: 10, marginTop: 10, flexWrap: "wrap" }}>
          <span className="text-gradient" style={{ fontSize: 16, fontWeight: 800, letterSpacing: 1 }}>RANGE</span>
          <input type="number" value={startNo} onChange={e => { const v = e.target.value; if (v === "") { setStartNo(""); return; } const n = parseInt(v, 10); if (!isNaN(n)) { setStartNo(n.toString()); if (n > (parseInt(endNo, 10) || n)) setEndNo(n.toString()); } }}
            style={inputStyle} />
          <span style={{ color: "#555", fontSize: 20, fontWeight: 300 }}>—</span>
          <input type="number" value={endNo} onChange={e => { const v = e.target.value; if (v === "") { setEndNo(""); return; } const n = parseInt(v, 10); if (!isNaN(n)) { setEndNo(n.toString()); if (n < (parseInt(startNo, 10) || n)) setStartNo(n.toString()); } }}
            style={inputStyle} />

          {/* Dual range slider — ijo dorong biru, biru dorong ijo */}
          <div className="dual-range">
            <input type="range" min={1} max={sliderMax} value={parseInt(startNo, 10) || 1}
              onChange={e => { const v = parseInt(e.target.value, 10); setStartNo(String(v)); if (v > (parseInt(endNo, 10) || v)) setEndNo(String(v)); }} />
            <input type="range" min={1} max={sliderMax} value={parseInt(endNo, 10) || sliderMax}
              onChange={e => { const v = parseInt(e.target.value, 10); setEndNo(String(v)); if (v < (parseInt(startNo, 10) || v)) setStartNo(String(v)); }} />
          </div>

          {/* Memorized filter pills */}
          {([
            { key: "all" as MemFilter, label: "Semua", bg: "#1a6fe0" },
            { key: "memorized" as MemFilter, label: "Hafal", bg: "#3aa655" },
            { key: "not_memorized" as MemFilter, label: "Belum Hafal", bg: "#c0392b" },
          ]).map(f => (
            <button key={f.key} className="nf-btn nf-btn-neon" style={{
              "--btn-bg1": memFilter === f.key ? f.bg + "33" : "#1a1a2e",
              "--btn-bg2": memFilter === f.key ? f.bg : "#2a2a3e",
              "--btn-neon1": memFilter === f.key ? f.bg : "#3a3a5e",
              "--btn-neon2": memFilter === f.key ? f.bg : "#2a2a3e",
              "--btn-text": memFilter === f.key ? "#fff" : "#666",
              fontSize: 14, padding: "8px 12px"
            } as React.CSSProperties} onClick={() => setMemFilter(f.key)}>
              {f.label}
            </button>
          ))}

          <div style={{ height: 24, width: 1, background: "rgba(255,255,255,0.2)" }} />

          <button className="nf-btn nf-btn-neon" style={
            {"--btn-bg1":"#002010","--btn-bg2":"#1ac8a0","--btn-neon1":"#2aebc0","--btn-neon2":"#1ac8a0","--btn-text":"#fff",fontSize:17,padding:"10px 22px"} as React.CSSProperties}
            onClick={startTest}>▶ START TEST</button>
        </div>
      )}

      {/* Progress bar */}
      {active && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", background: "rgba(255,255,255,0.03)", borderRadius: 10, marginTop: 10 }}>
          <span style={{ fontSize: 13, color: "#aaa", minWidth: 80, fontVariantNumeric: "tabular-nums" }}>Soal {index + 1} / {questions.length}</span>
          <div style={{ flex: 1, background: "rgba(255,255,255,0.08)", borderRadius: 999, height: 6, overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, background: "linear-gradient(90deg, #39ff14, #2fe6e6)", borderRadius: 999, height: 6, transition: "width 0.3s" }} />
          </div>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#8fe388", textShadow: "0 0 8px rgba(143,227,136,0.4)" }}>✓ {correct}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#ff8095", textShadow: "0 0 8px rgba(255,128,149,0.4)" }}>✗ {wrong}</span>
          <div style={{ height: 20, width: 1, background: "rgba(255,255,255,0.1)" }} />
          <button className="nf-btn nf-btn-neon nf-btn-sm" style={{"--btn-bg1":"#200005","--btn-bg2":"#e03040","--btn-neon1":"#ff5a6a","--btn-neon2":"#e03040","--btn-text":"#fff"} as React.CSSProperties}
            onClick={resetProgress}>RESET</button>
        </div>
      )}

      {/* Empty state */}
      {!active && (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12, color: "#333" }}>
          <div className="jp" style={{ fontSize: 80, opacity: 0.1 }}>漢</div>
          <div style={{ fontSize: 16 }}>Pilih level, atur range, lalu klik START TEST</div>
        </div>
      )}

      {/* Question area */}
      {active && current && (
        <div key={`${index}-${mode}`} style={{ animation: "fadeCard 0.25s ease", display: "flex", flexDirection: "column", gap: 14, flex: 1, marginTop: 10 }}>
          {/* Label row */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ background: "#f5e64222", border: "1px solid #f5e64244", borderRadius: 6, padding: "4px 12px", fontSize: 11, color: "#f5e642", fontWeight: "bold", textTransform: "uppercase", letterSpacing: 1 }}>
              Soal {index + 1} dari {questions.length}
            </div>
            <div style={{ fontSize: 12, color: "#555" }}>{mode === "artiOnly" ? "Hanya Arti" : mode === "kanaOnly" ? "Hanya Kana" : "Arti + Kana"}</div>
          </div>

          {/* Card */}
          <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 12, padding: 12, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 100 }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
                {mode === "artiOnly" ? "Apa arti dari kanji ini?" : mode === "kanaOnly" ? "Bagaimana cara baca (kana) kanji ini?" : "Tulis arti & cara baca (kana) dari kanji ini:"}
              </div>
              <div className="jp" style={{ fontSize: 62, color: "#fff", fontWeight: "bold", lineHeight: 1.1, textShadow: "0 0 20px rgba(255,255,255,0.1)" }}>
                {soalText}
              </div>
            </div>
          </div>

          {/* Input — auto-switch keyboard: field arti = EN, field kana = JA */}
          {mode === "artiOnly" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1 }}>Jawaban kamu:</div>
              <textarea key={index} value={answer} onChange={e => setAnswer(e.target.value)} disabled={answered} autoFocus
                onFocus={() => setKB("en")}
                placeholder="Ketik arti di sini... (Enter untuk cek / lanjut)"
                style={{ background: "#1a1a2e", border: `2px solid ${answered ? (feedback?.ok ? "#3a6a3a" : "#6a1a1a") : "rgba(255,255,255,0.15)"}`, borderRadius: 8, padding: "10px 12px", fontSize: 18, color: "#fff", resize: "vertical", minHeight: 54, fontFamily: "var(--font-display)", outline: "none", boxShadow: answered ? (feedback?.ok ? "0 0 12px rgba(57,255,20,0.15)" : "0 0 12px rgba(255,90,122,0.15)") : "0 0 12px rgba(47,230,230,0.08)", transition: "border-color 0.2s, box-shadow 0.2s" }} />
            </div>
          ) : mode === "kanaOnly" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div className="jp" style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1 }}>Jawaban kamu (かな):</div>
              <textarea key={index} value={kanaAnswer} onChange={e => setKanaAnswer(e.target.value)} disabled={answered} autoFocus
                onFocus={() => setKB("ja")}
                placeholder="かな... (Enter untuk cek / lanjut)"
                style={{ background: "#1a1a2e", border: `2px solid ${answered ? (feedback?.ok ? "#3a6a3a" : "#6a1a1a") : "rgba(255,255,255,0.15)"}`, borderRadius: 8, padding: "10px 12px", fontSize: 18, color: "#fff", resize: "vertical", minHeight: 54, fontFamily: "var(--font-jp)", outline: "none", boxShadow: answered ? (feedback?.ok ? "0 0 12px rgba(57,255,20,0.15)" : "0 0 12px rgba(255,90,122,0.15)") : "0 0 12px rgba(47,230,230,0.08)", transition: "border-color 0.2s, box-shadow 0.2s" }} />
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1 }}>1 · Arti (Bahasa Indonesia):</div>
                <textarea key={`imi-${index}`} value={answer} onChange={e => setAnswer(e.target.value)} disabled={answered} autoFocus
                  onFocus={() => setKB("en")}
                  placeholder="Arti bahasa Indonesia... (Enter untuk cek / lanjut)"
                  style={{ background: "#1a1a2e", border: `2px solid ${answered ? (feedback?.ok ? "#3a6a3a" : "#6a1a1a") : "rgba(255,255,255,0.15)"}`, borderRadius: 8, padding: "10px 12px", fontSize: 16, color: "#fff", resize: "vertical", minHeight: 46, fontFamily: "var(--font-display)", outline: "none", boxShadow: "0 0 12px rgba(47,230,230,0.08)", transition: "border-color 0.2s" }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div className="jp" style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1 }}>2 · Kana (cara baca):</div>
                <textarea key={`kana-${index}`} value={kanaAnswer} onChange={e => setKanaAnswer(e.target.value)} disabled={answered}
                  onFocus={() => setKB("ja")}
                  placeholder="かな... (Enter untuk cek / lanjut)"
                  style={{ background: "#1a1a2e", border: `2px solid ${answered ? (feedback?.ok ? "#3a6a3a" : "#6a1a1a") : "rgba(255,255,255,0.15)"}`, borderRadius: 8, padding: "10px 12px", fontSize: 16, color: "#fff", resize: "vertical", minHeight: 46, fontFamily: "var(--font-jp)", outline: "none", boxShadow: "0 0 12px rgba(47,230,230,0.08)", transition: "border-color 0.2s" }} />
              </div>
            </div>
          )}

          {/* CEK JAWABAN */}
          {!answered && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
              <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":"#002010","--btn-bg2":"#2adb10","--btn-neon1":"#3aeb20","--btn-neon2":"#2adb10","--btn-text":"#000",fontSize:16,padding:"10px 28px"} as React.CSSProperties}
                onClick={cek}>CEK JAWABAN</button>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#5a9fff", textShadow: "0 0 8px rgba(90,159,255,0.6), 0 0 20px rgba(90,159,255,0.3)" }}>Enter</span>
            </div>
          )}
        </div>
      )}

      {/* Bottom feedback */}
      {active && answered && feedback && (
        <div ref={feedbackRef} style={{ animation: "popIn 0.35s cubic-bezier(0.175,0.885,0.32,1.275)", background: feedback!.ok ? "linear-gradient(135deg,#0d2a14,#0f3a1a)" : "linear-gradient(135deg,#2a0f14,#3a0f1a)", border: `2px solid ${feedback!.ok ? "#39ff14" : "#ff3b5c"}`, borderRadius: 16, padding: "20px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16, boxShadow: feedback!.ok ? "0 0 24px rgba(57,255,20,0.35), 0 0 60px rgba(57,255,20,0.15)" : "0 0 24px rgba(255,59,92,0.35), 0 0 60px rgba(255,59,92,0.15)", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 40, lineHeight: 1, filter: feedback!.ok ? "drop-shadow(0 0 8px rgba(57,255,20,0.6))" : "drop-shadow(0 0 8px rgba(255,59,92,0.6))" }}>{feedback.ok ? "✅" : "❌"}</span>
            <div>
              <div style={{ fontSize: 28, fontWeight: 900, color: feedback!.ok ? "#39ff14" : "#ff5a7a", textShadow: feedback!.ok ? "0 0 12px rgba(57,255,20,0.5)" : "0 0 12px rgba(255,59,92,0.5)", letterSpacing: 1.2, lineHeight: 1 }}>{feedback!.text}</div>
              <div style={{ fontSize: 11, color: "#888", letterSpacing: 1.2, textTransform: "uppercase", marginTop: 6 }}>Jawaban benar:</div>
              {feedback!.jawaban.includes(" • ") ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 2 }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "#fff", wordBreak: "break-word" }}>Arti: {feedback!.jawaban.split(" • ")[0]}</div>
                  <div className="jp" style={{ fontSize: 18, fontWeight: 700, color: "#fff", wordBreak: "break-word" }}>Kana: {feedback!.jawaban.split(" • ")[1]}</div>
                </div>
              ) : (
                <div style={{ fontSize: 22, fontWeight: 700, color: "#fff", marginTop: 2, wordBreak: "break-word", textShadow: "0 0 10px rgba(255,255,255,0.15)" }}>{feedback!.jawaban}</div>
              )}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <button className="nf-btn nf-btn-neon" autoFocus style={{"--btn-bg1":"#000d1a","--btn-bg2":"#3a7fff","--btn-neon1":"#5a9fff","--btn-neon2":"#3a7fff","--btn-text":"#fff",fontSize:16,padding:"12px 28px"} as React.CSSProperties}
              onClick={next}>{index === questions.length - 1 ? "CEK HASIL" : "SOAL BERIKUTNYA →"}</button>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#4d94ff", textShadow: "0 0 8px rgba(77,148,255,0.6), 0 0 20px rgba(77,148,255,0.3)" }}>→</span>
          </div>
        </div>
      )}
    </ScreenLayout>
  );
}

function ResultScreen({ questions, onRetry, onClose }: { questions: Q[]; correct: number; wrong: number; onRetry: () => void; onClose: () => void; }) {
  const confirm = useConfirm();
  const total = questions.length;
  // hitung dari status ASLI soal — counter kumulatif bisa dobel-nambah
  // (Enter IME / Enter ganda) sehingga tidak dipercaya untuk tampilan
  const benarCount = questions.filter(q => q.status === "BENAR").length;
  const salahCount = questions.filter(q => q.status === "SALAH").length;
  const skor = total > 0 ? Math.round((benarCount / total) * 100) : 0;
  const [filter, setFilter] = useState<"ALL" | "BENAR" | "SALAH">("ALL");
  const [hafalSet, setHafalSet] = useState<Set<number>>(() => new Set(questions.filter(q => q.memorized === 1).map(q => q.rowid)));
  const shown = questions.filter(q => filter === "ALL" ? true : q.status === filter);
  const scoreColor = skor >= 70 ? "#39ff14" : "#ff5a7a";

  // hitungan untuk aksi bulk (reaktif terhadap hafalSet)
  const nBenarBelumHafal = questions.filter(q => q.status === "BENAR" && !hafalSet.has(q.rowid)).length;
  const nSalahMasihHafal = questions.filter(q => q.status === "SALAH" && hafalSet.has(q.rowid)).length;

  async function bulkSetMemorized(ids: number[], value: number) {
    const db = await getDb();
    const CHUNK = 400;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      await db.execute(
        `UPDATE kotoba SET memorized_kanji = ${value} WHERE id IN (${part.map((_, j) => `$${j + 1}`).join(",")})`,
        part
      );
    }
  }

  async function handleMarkAllCorrect() {
    if (nBenarBelumHafal === 0) return;
    const ok = await confirm(`Tandai semua soal benar (${nBenarBelumHafal}) sebagai hafal?`);
    if (!ok) return;
    try {
      const targets = questions.filter(q => q.status === "BENAR" && !hafalSet.has(q.rowid));
      await bulkSetMemorized(targets.map(t => t.rowid), 1);
      setHafalSet(prev => { const s = new Set(prev); targets.forEach(t => s.add(t.rowid)); return s; });
    } catch (e) { alert("Error: " + String(e)); }
  }

  async function handleUnmarkAllWrong() {
    if (nSalahMasihHafal === 0) return;
    const ok = await confirm(`Hapus tanda hafal dari ${nSalahMasihHafal} soal salah?`);
    if (!ok) return;
    try {
      const targets = questions.filter(q => q.status === "SALAH" && hafalSet.has(q.rowid));
      await bulkSetMemorized(targets.map(t => t.rowid), 0);
      setHafalSet(prev => { const s = new Set(prev); targets.forEach(t => s.delete(t.rowid)); return s; });
    } catch (e) { alert("Error: " + String(e)); }
  }

  async function handleHafal(rowid: number) {
    try {
      const db = await getDb();
      await db.execute("UPDATE kotoba SET memorized_kanji = 1 WHERE id = $1", [rowid]);
      setHafalSet(prev => new Set(prev).add(rowid));
    } catch (e) { alert("Error: " + String(e)); }
  }
  async function handleUnhafal(rowid: number) {
    try {
      const db = await getDb();
      await db.execute("UPDATE kotoba SET memorized_kanji = 0 WHERE id = $1", [rowid]);
      setHafalSet(prev => { const s = new Set(prev); s.delete(rowid); return s; });
    } catch (e) { alert("Error: " + String(e)); }
  }

  return (
    <ScreenLayout subtitle="📊 HASIL KANJI TEST" onClose={onClose} logo={60} logoCentered width={1000} fillHeight
      headerRight={
        <span style={{ fontSize: 28, fontWeight: "bold", color: scoreColor, textShadow: `0 0 12px ${skor >= 70 ? "rgba(57,255,20,0.4)" : "rgba(255,90,122,0.4)"}` }}>{skor}%</span>
      }>
      <style>{`
        @keyframes fadeCard { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      <div style={{ animation: "fadeCard 0.25s ease", display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Stats row */}
        <div style={{ display: "flex", gap: 16, alignItems: "center", padding: "12px 16px", background: "rgba(255,255,255,0.03)", borderRadius: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#8fe388", textShadow: "0 0 8px rgba(143,227,136,0.4)" }}>● Benar: {benarCount}</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#bcbcff", textShadow: "0 0 8px rgba(188,188,255,0.3)" }}>● Salah: {salahCount}</span>
          <span style={{ fontSize: 14, color: "#ddd" }}>Total: {total}</span>
          <div style={{ flex: 1 }} />
          <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":"#002010","--btn-bg2":"#2adb10","--btn-neon1":"#3aeb20","--btn-neon2":"#2adb10","--btn-text":"#000",fontSize:15,padding:"8px 22px"} as React.CSSProperties}
            onClick={onRetry}>TEST LAGI</button>
          <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":"#200005","--btn-bg2":"#e03040","--btn-neon1":"#ff5a6a","--btn-neon2":"#e03040","--btn-text":"#fff",fontSize:15,padding:"8px 22px"} as React.CSSProperties}
            onClick={onClose}>KEMBALI KE MENU</button>
        </div>

        {/* Aksi bulk hafal */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="nf-btn nf-btn-neon" disabled={nBenarBelumHafal === 0} style={nBenarBelumHafal === 0 ? {"--btn-bg1":"#1a1a1a","--btn-bg2":"#2a2a2a","--btn-neon1":"#444","--btn-neon2":"#333","--btn-text":"#555",fontSize:13,padding:"8px 16px"} as React.CSSProperties : {"--btn-bg1":"#002010","--btn-bg2":"#3aa655","--btn-neon1":"#8fe388","--btn-neon2":"#3aa655","--btn-text":"#fff",fontSize:13,padding:"8px 16px"} as React.CSSProperties}
            onClick={handleMarkAllCorrect}>✓ Tandai Hafal Semua Benar ({nBenarBelumHafal})</button>
          <button className="nf-btn nf-btn-neon" disabled={nSalahMasihHafal === 0} style={nSalahMasihHafal === 0 ? {"--btn-bg1":"#1a1a1a","--btn-bg2":"#2a2a2a","--btn-neon1":"#444","--btn-neon2":"#333","--btn-text":"#555",fontSize:13,padding:"8px 16px"} as React.CSSProperties : {"--btn-bg1":"#200005","--btn-bg2":"#e03040","--btn-neon1":"#ff5a6a","--btn-neon2":"#e03040","--btn-text":"#fff",fontSize:13,padding:"8px 16px"} as React.CSSProperties}
            onClick={handleUnmarkAllWrong}>✗ Hapus Tanda Hafal Semua Salah ({nSalahMasihHafal})</button>
        </div>

        {/* Filter pills */}
        <div style={{ display: "flex", gap: 8 }}>
          {(["ALL", "BENAR", "SALAH"] as const).map(f => {
            const labelMap = { ALL: `Semua (${total})`, BENAR: `Benar (${benarCount})`, SALAH: `Salah (${salahCount})` };
            const colorMap = { ALL: "#1a6fe0", BENAR: "#3aa655", SALAH: "#c0392b" };
            const isActive = filter === f;
            return (
              <button key={f} className="nf-btn nf-btn-neon" style={{
                "--btn-bg1": isActive ? colorMap[f] + "33" : "#2a2a2a",
                "--btn-bg2": isActive ? colorMap[f] : "#3a3a3a",
                "--btn-neon1": isActive ? colorMap[f] : "#444",
                "--btn-neon2": isActive ? colorMap[f] : "#3a3a3a",
                "--btn-text": isActive ? "#fff" : "#ccc",
                fontSize: 14, padding: "8px 18px"
              } as React.CSSProperties} onClick={() => setFilter(f)}>
                {labelMap[f]}
              </button>
            );
          })}
        </div>

        {/* Results table */}
        <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.6fr 1.6fr 100px 130px", gap: 10, padding: "12px 16px", background: "rgba(255,255,255,0.05)", color: "#fff", fontWeight: "bold", fontSize: 12, textTransform: "uppercase", letterSpacing: 1 }}>
            <div>Kanji</div><div>Arti</div><div>Jawaban Anda</div><div style={{ textAlign: "center" }}>Status</div><div style={{ textAlign: "center" }}>Aksi</div>
          </div>
          <div style={{ maxHeight: "50vh", overflowY: "auto" }}>
            {shown.map((q, i) => {
              const benar = q.status === "BENAR";
              return (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "1.2fr 1.6fr 1.6fr 100px 130px", gap: 10, padding: "10px 16px", alignItems: "center", background: i % 2 ? "rgba(255,255,255,0.03)" : "transparent", color: "#ddd", borderLeft: `4px solid ${benar ? "#3aa655" : "#c0392b"}` }}>
                  <div className="jp" style={{ fontSize: 22 }}>{q.kanji}</div>
                  <div>{q.imi}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 13 }}>
                    {q.userImi !== undefined && q.userKana !== undefined ? (
                      <>
                        <span>Arti: {q.userImi || "(kosong)"} <span style={{ color: q.userImi && checkAnswer(q.userImi, q.imi) ? "#3aa655" : "#c0392b", fontWeight: 700 }}>{q.userImi && checkAnswer(q.userImi, q.imi) ? "✓" : "✗"}</span></span>
                        <span className="jp">Kana: {q.userKana || "(kosong)"} <span style={{ color: q.userKana && kanaMatch(q.userKana, q.nihongo) ? "#3aa655" : "#c0392b", fontWeight: 700 }}>{q.userKana && kanaMatch(q.userKana, q.nihongo) ? "✓" : "✗"}</span></span>
                      </>
                    ) : q.userKana !== undefined ? (
                      <span className="jp">Kana: {q.userKana || "(kosong)"} <span style={{ color: q.userKana && kanaMatch(q.userKana, q.nihongo) ? "#3aa655" : "#c0392b", fontWeight: 700 }}>{q.userKana && kanaMatch(q.userKana, q.nihongo) ? "✓" : "✗"}</span></span>
                    ) : (
                      <span style={{ fontStyle: q.user ? "normal" : "italic", color: q.user ? "#ddd" : "#666" }}>{q.user || "(kosong)"}</span>
                    )}
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <span style={{ display: "inline-block", padding: "3px 12px", borderRadius: 999, fontSize: 12, fontWeight: "bold", color: "#fff", background: benar ? "#3aa655" : "#c0392b", boxShadow: benar ? "0 0 8px rgba(58,166,85,0.4)" : "0 0 8px rgba(192,57,43,0.4)" }}>{q.status}</span>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    {benar && !hafalSet.has(q.rowid) ? (
                      <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":"#000d1a","--btn-bg2":"#3a7fff","--btn-neon1":"#5a9fff","--btn-neon2":"#3a7fff","--btn-text":"#fff",fontSize:11,padding:"4px 10px"} as React.CSSProperties}
                        onClick={() => handleHafal(q.rowid)}>+ Tandai Hafal</button>
                    ) : benar ? (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                        <span style={{ fontSize: 11, color: "#3aa655" }}>✅ Hafal</span>
                        <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":"#2a0a0a","--btn-bg2":"#c0392b","--btn-neon1":"#e05a4a","--btn-neon2":"#c0392b","--btn-text":"#fff",fontSize:10,padding:"3px 8px"} as React.CSSProperties}
                          onClick={() => handleUnhafal(q.rowid)}>↩ Batal</button>
                      </div>
                    ) : hafalSet.has(q.rowid) ? (
                      <button className="nf-btn nf-btn-neon" style={{"--btn-bg1":"#2a0a0a","--btn-bg2":"#c0392b","--btn-neon1":"#e05a4a","--btn-neon2":"#c0392b","--btn-text":"#fff",fontSize:11,padding:"4px 10px"} as React.CSSProperties}
                        onClick={() => handleUnhafal(q.rowid)}>Hilangkan tanda hafal</button>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {shown.length === 0 && <div style={{ padding: 24, textAlign: "center", color: "#555" }}>Tidak ada data.</div>}
          </div>
        </div>
      </div>

    </ScreenLayout>
  );
}
