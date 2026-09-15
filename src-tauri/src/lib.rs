// ===================================================================
// NihonForge Mobile - Rust backend (Android)
// Subset dari versi desktop: hanya yang dipakai 3 layar latihan.
// Commands: google_tts (audio online, fallback ke Speech API di tts.ts)
// Database: SQLite via tauri-plugin-sql + migrasi v1..v7 (skema sama persis
// dengan desktop agar snapshot progress bisa diterapkan).
// ===================================================================

use tauri_plugin_sql::{Migration, MigrationKind};
use tauri_plugin_http::reqwest;

// -------------------------------------------------------------------
// COMMAND: google_tts
// Menerima teks + kode bahasa ("ja" / "id"), mengunduh MP3 dari
// Google Translate, lalu mengembalikan byte MP3 (untuk diputar di React).
// -------------------------------------------------------------------
#[tauri::command]
async fn google_tts(text: String, lang: String) -> Result<Vec<u8>, String> {
    if text.trim().is_empty() || text == "-" {
        return Err("teks kosong".into());
    }

    let tl = if lang == "id" { "id" } else { "ja" };

    // Encode teks untuk dimasukkan ke URL
    let encoded = urlencoding::encode(&text);
    let url = format!(
        "https://translate.google.com/translate_tts?ie=UTF-8&tl={}&client=tw-ob&q={}",
        tl, encoded
    );

    // Google menolak request tanpa User-Agent seperti browser
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
        .map_err(|e| format!("gagal request: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("status google tts: {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("gagal baca data: {}", e))?;

    Ok(bytes.to_vec())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "buat semua tabel awal nihonforge",
            sql: "
                CREATE TABLE IF NOT EXISTS kotoba (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    nihongo     TEXT NOT NULL,
                    imi         TEXT,
                    kanji       TEXT DEFAULT '-',
                    explanation TEXT
                );
                CREATE TABLE IF NOT EXISTS ai_models (
                    id    INTEGER PRIMARY KEY AUTOINCREMENT,
                    name  TEXT NOT NULL,
                    code  TEXT NOT NULL,
                    note  TEXT
                );
                CREATE TABLE IF NOT EXISTS prompts (
                    key   TEXT PRIMARY KEY,
                    value TEXT
                );
                CREATE TABLE IF NOT EXISTS settings (
                    key   TEXT PRIMARY KEY,
                    value TEXT
                );
                CREATE TABLE IF NOT EXISTS history (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    tanggal     TEXT,
                    range_text  TEXT,
                    skor        INTEGER,
                    mode        TEXT
                );
                CREATE TABLE IF NOT EXISTS wrong_words (
                    id        INTEGER PRIMARY KEY AUTOINCREMENT,
                    word      TEXT,
                    frekuensi INTEGER DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS license (
                    id                     INTEGER PRIMARY KEY CHECK (id = 1),
                    license_key            TEXT,
                    device_hash            TEXT,
                    last_online_validation TEXT,
                    install_id             TEXT,
                    offline_expiry         TEXT
                );
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "tambah kolom memorized di kotoba",
            sql: "ALTER TABLE kotoba ADD COLUMN memorized INTEGER NOT NULL DEFAULT 0;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "tambah kolom memorized_kanji di kotoba",
            sql: "ALTER TABLE kotoba ADD COLUMN memorized_kanji INTEGER NOT NULL DEFAULT 0;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "tambah kolom provider di ai_models",
            sql: "ALTER TABLE ai_models ADD COLUMN provider TEXT NOT NULL DEFAULT 'openrouter';",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "bersihkan memorized_kanji yang nyangkut pada kata tanpa kanji",
            sql: "UPDATE kotoba SET memorized_kanji = 0 WHERE kanji IS NULL OR TRIM(kanji) IN ('', '-', 'ー');",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "perbaiki nihongo yang nyampur kanji (お子さん -> おこさん, やくに立つ -> やくにたつ)",
            sql: "
                UPDATE kotoba SET nihongo = 'おこさん', kanji = 'お子さん' WHERE nihongo = 'お子さん' AND kanji = '-';
                UPDATE kotoba SET nihongo = 'やくにたつ' WHERE nihongo = 'やくに立つ' AND kanji = '役に立つ';
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "tambah kolom level (N1-N5/GENERAL) di kotoba",
            sql: "ALTER TABLE kotoba ADD COLUMN level TEXT NOT NULL DEFAULT 'GENERAL';",
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:nihonforge-mobile.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![google_tts])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
