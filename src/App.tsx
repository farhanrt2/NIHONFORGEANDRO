import { useEffect, useState } from "react";
import "./app.css";
import { ModalProvider } from "./Modal";
import {
  seedIfEmpty,
  countKotoba,
  countKanji,
  countMemorizedKana,
  countMemorizedKanji,
} from "./db";
import Flashcard from "./Flashcard";
import KotobaTest from "./KotobaTest";
import KanjiTest from "./KanjiTest";
import KotobaProgress from "./KotobaProgress";

type Screen = "menu" | "flashcard" | "kotoba" | "kanji" | "progress";

// Kunci orientasi via Screen Orientation API (progressive enhancement).
// Di WebView yang tidak mendukung, gagal diam-diam: user putar manual
// dan overlay "putar HP" yang memandu.
async function lockOrientation(o: "portrait" | "landscape"): Promise<void> {
  try {
    const so = (screen as unknown as { orientation?: { lock?: (o: string) => Promise<void> } }).orientation;
    if (so?.lock) await so.lock(o);
  } catch {
    /* abaikan */
  }
}

function unlockOrientation(): void {
  try {
    (screen as unknown as { orientation?: { unlock?: () => void } }).orientation?.unlock?.();
  } catch {
    /* abaikan */
  }
}

export default function App() {
  const [booted, setBooted] = useState(false);
  const [bootMsg, setBootMsg] = useState("Menyiapkan database...");
  const [screen, setScreen] = useState<Screen>("menu");
  const [isPortrait, setIsPortrait] = useState(
    () => window.matchMedia("(orientation: portrait)").matches
  );
  const [prog, setProg] = useState({ kana: 0, kanaTotal: 0, kanji: 0, kanjiTotal: 0 });

  useEffect(() => {
    const mq = window.matchMedia("(orientation: portrait)");
    const onChange = (e: MediaQueryListEvent) => setIsPortrait(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await seedIfEmpty();
        const [kana, kanaTotal, kanji, kanjiTotal] = await Promise.all([
          countMemorizedKana(),
          countKotoba(),
          countMemorizedKanji(),
          countKanji(),
        ]);
        setProg({ kana, kanaTotal, kanji, kanjiTotal });
        setBooted(true);
      } catch (e) {
        console.error(e);
        setBootMsg("Gagal menyiapkan aplikasi: " + String(e));
      }
    })();
  }, []);

  // Menu + progress = portrait (sensor), layar latihan = coba kunci landscape.
  useEffect(() => {
    if (screen === "menu" || screen === "progress") unlockOrientation();
    else void lockOrientation("landscape");
  }, [screen]);

  if (!booted) {
    return (
      <div className="m-splash">
        <div className="m-splash-title">NihonForge</div>
        <div className="m-splash-sub">mobile ・ untuk latihan sambil tiduran</div>
        <div className="m-splash-msg">{bootMsg}</div>
      </div>
    );
  }

  const go = (s: Screen) => setScreen(s);
  const needRotate =
    (screen === "flashcard" || screen === "kotoba" || screen === "kanji") &&
    isPortrait;

  return (
    <ModalProvider>
    <div className="m-root">
      {screen === "menu" && (
        <div className="m-menu">
          <div className="m-menu-head">
            <div className="m-menu-title">NihonForge</div>
            <div className="m-menu-sub">mobile</div>
          </div>
          <div className="m-menu-prog">
            Kana {prog.kana}/{prog.kanaTotal} ・ Kanji {prog.kanji}/{prog.kanjiTotal}
          </div>
          <div className="m-menu-btns">
            <button className="m-bigbtn m-b1" onClick={() => go("flashcard")}>
              <span className="m-bigbtn-t">🎴 Flashcard</span>
              <span className="m-bigbtn-s">putar HP ↻</span>
            </button>
            <button className="m-bigbtn m-b2" onClick={() => go("kotoba")}>
              <span className="m-bigbtn-t">✨ Kotoba Test</span>
              <span className="m-bigbtn-s">putar HP ↻</span>
            </button>
            <button className="m-bigbtn m-b3" onClick={() => go("kanji")}>
              <span className="m-bigbtn-t">✨ Kanji Test</span>
              <span className="m-bigbtn-s">putar HP ↻</span>
            </button>
            <button className="m-bigbtn m-b4" onClick={() => go("progress")}>
              <span className="m-bigbtn-t">📊 Progress</span>
              <span className="m-bigbtn-s">ringkasan hafalan</span>
            </button>
          </div>
          <div className="m-menu-foot">progress tersimpan di HP ini</div>
        </div>
      )}
      {screen === "flashcard" && <Flashcard onClose={() => go("menu")} />}
      {screen === "kotoba" && <KotobaTest onClose={() => go("menu")} />}
      {screen === "kanji" && <KanjiTest onClose={() => go("menu")} />}
      {screen === "progress" && <KotobaProgress onClose={() => go("menu")} />}
      {needRotate && (
        <div className="m-rotate">
          <div className="m-rotate-card">
            <div className="m-rotate-ico">↻</div>
            <div className="m-rotate-t">Putar HP ke landscape</div>
            <div className="m-rotate-s">Layar latihan didesain horizontal</div>
          </div>
        </div>
      )}
    </div>
    </ModalProvider>
  );
}
