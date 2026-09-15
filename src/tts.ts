// ===================================================================
// tts.ts - Text To Speech untuk NihonForge
//
// PRIORITAS (sesuai permintaan, untuk SELAIN listening test):
//   1. Google TTS (translate.google.com) -- via Rust
//   2. Windows TTS (suara bawaan sistem) -- fallback
//
// Catatan: Google TTS diambil lewat Rust (command "google_tts")
// karena browser memblokir akses langsung ke Google (CORS).
// ===================================================================

import { invoke } from "@tauri-apps/api/core";

type Lang = "ja" | "id";

// Simpan elemen audio yang sedang berputar agar bisa dihentikan
let currentAudio: HTMLAudioElement | null = null;

// ---- Fallback: Windows / suara bawaan sistem (Web Speech API) ----
function speakWindows(text: string, lang: Lang) {
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = lang === "ja" ? "ja-JP" : "id-ID";
    utter.rate = 0.95;
    const voices = window.speechSynthesis.getVoices();
    const prefix = lang === "ja" ? "ja" : "id";
    const v = voices.find((vo) => vo.lang.toLowerCase().startsWith(prefix));
    if (v) utter.voice = v;
    window.speechSynthesis.speak(utter);
  } catch (e) {
    console.error("Windows TTS gagal:", e);
  }
}

/**
 * Ucapkan teks. Coba Google TTS dulu, kalau gagal pakai Windows TTS.
 * @param text teks yang dibaca
 * @param lang "ja" (default) untuk Jepang, "id" untuk Indonesia
 */
export async function speak(text: string, lang: Lang = "ja") {
  if (!text || text.trim() === "" || text === "-") return;

  // Hentikan audio sebelumnya
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  window.speechSynthesis.cancel();

  try {
    // 1) GOOGLE TTS lewat Rust -> dapat byte MP3
    const bytes = await invoke<number[]>("google_tts", { text, lang });
    const blob = new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
  } catch (e) {
    // 2) FALLBACK: Windows TTS
    console.warn("Google TTS gagal, pakai Windows TTS. Detail:", e);
    speakWindows(text, lang);
  }
}

// Panggil sekali saat aplikasi mulai agar daftar voice Windows siap.
export function warmUpVoices() {
  if (typeof window !== "undefined" && window.speechSynthesis) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () => {
      window.speechSynthesis.getVoices();
    };
  }
}

// ===================================================================
// LISTENING TEST: prioritas VoiceVox -> Google TTS -> Windows TTS
// ===================================================================

// profil suara default (bisa di-override dari luar)
export const VV_DEFAULTS = {
  N: 94,
  M: 11,
  F: 29,
};

let vvOverride: { N: number; M: number; F: number } | null = null;

export function setVoicevoxSpeakers(n: number, m: number, f: number) {
  vvOverride = { N: n, M: m, F: f };
}

function getVVProfiles() {
  const speakers = vvOverride ?? VV_DEFAULTS;
  return {
    N: { speaker: speakers.N, speed: 0.78, pitch: 0, intonation: 1.5, volume: 2 },
    M: { speaker: speakers.M, speed: 0.8,  pitch: 0, intonation: 1.5, volume: 2 },
    F: { speaker: speakers.F, speed: 0.9,  pitch: -0.02, intonation: 2, volume: 2 },
  };
}

// putar byte audio, resolve saat selesai
function playBytes(bytes: number[], mime: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const blob = new Blob([new Uint8Array(bytes)], { type: mime });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudio = audio;
      audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
      audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error("audio error")); };
      audio.play().catch(reject);
    } catch (e) {
      reject(e);
    }
  });
}

// fallback Windows TTS dengan pitch sesuai peran, resolve saat selesai
function speakWindowsAwait(text: string, role: "N" | "M" | "F"): Promise<void> {
  return new Promise((resolve) => {
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ja-JP";
      u.pitch = role === "M" ? 0.7 : role === "F" ? 1.3 : 1.0;
      u.rate = 0.9;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    } catch {
      resolve();
    }
  });
}

// voice mapping Edge TTS per role
const EDGE_TTS_VOICES = {
  N: "ja-JP-NanamiNeural",  // narrator — wanita natural
  M: "ja-JP-KeitaNeural",   // pria
  F: "ja-JP-NanamiNeural",  // wanita
};

async function speakEdgeTts(text: string, role: "N" | "M" | "F"): Promise<void> {
  const voice = EDGE_TTS_VOICES[role];
  const bytes = await invoke<number[]>("edge_tts", { text, voice });
  await playBytes(bytes, "audio/mpeg");
}

/**
 * Ucapkan teks untuk Listening Test.
 * Prioritas: VoiceVox -> Edge TTS -> Google TTS -> Windows TTS.
 * @param role "N" narrator, "M" pria, "F" wanita
 */
export async function speakListening(text: string, role: "N" | "M" | "F"): Promise<void> {
  if (!text || text.trim() === "" || text === "-") return;
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  window.speechSynthesis.cancel();

  const p = getVVProfiles()[role];

  // 1) VOICEVOX (semua role termasuk N)
  try {
    const bytes = await invoke<number[]>("voicevox_tts", {
      text,
      speaker: p.speaker,
      speed: p.speed,
      pitch: p.pitch,
      intonation: p.intonation,
      volume: p.volume,
    });
    await playBytes(bytes, "audio/wav");
    return;
  } catch {
    console.warn("VoiceVox tidak aktif...");
  }

  // VoiceVox tidak running — Narrator pakai Google TTS, M/F pakai Edge TTS
  if (role === "N") {
    // 2N) GOOGLE TTS untuk narrator
    try {
      const bytes = await invoke<number[]>("google_tts", { text, lang: "ja" });
      await playBytes(bytes, "audio/mpeg");
      return;
    } catch {
      console.warn("Google TTS gagal, pakai Windows TTS...");
      await speakWindowsAwait(text, role);
      return;
    }
  }

  // 2) EDGE TTS (untuk M dan F)
  try {
    await speakEdgeTts(text, role);
    return;
  } catch {
    console.warn("Edge TTS tidak aktif, coba Google TTS...");
  }

  // 3) GOOGLE TTS (untuk M dan F)
  try {
    const bytes = await invoke<number[]>("google_tts", { text, lang: "ja" });
    await playBytes(bytes, "audio/mpeg");
    return;
  } catch {
    console.warn("Google TTS gagal, pakai Windows TTS...");
  }

  // 4) WINDOWS TTS
  await speakWindowsAwait(text, role);
}