# NihonForge Mobile

Latihan kotoba & kanji di HP. Companion dari NihonForge desktop, **database terpisah** — progress desktop dibawa sekali saat seed awal, habis itu jalan sendiri-sendiri.

## Scope v1 (sengaja kecil)

- Menu portrait: Flashcard, Kotoba Test, Kanji Test
- 3 layar latihan didesain **landscape** (putar HP; ada overlay pemandu + percobaan kunci orientasi otomatis)
- Tanpa audio TTS (backlog), tanpa sync, tanpa export/import

## Stack

React 19 + TypeScript + Vite 7 + Tauri v2 (Android) + SQLite (`nihonforge-mobile.db`, skema sama dengan desktop v1–v7).

File layar di-port dari repo desktop (copy, bukan submodule) agar kedua project bisa berubah tanpa saling mempengaruhi.

## Progress seed

`src/progress-seed.json` = snapshot flag hafalan DB desktop (key pasangan kana+kanji) + kata tambahan user. Diterapkan sekali saat seed awal (`progress_applied` marker di settings). Cara regenerate: lihat `scripts/` di repo desktop (extract via `better-sqlite3`).

## Build lokal (butuh Android SDK + NDK + JDK 17)

```powershell
npm install
npm run tauri android dev      # butuh HP/emulator + USB debugging
npm run tauri android build -- --debug --target aarch64
```

## CI

Push ke `main`/`master` → `.github/workflows/android.yml` → APK debug arm64 di Artifacts.
