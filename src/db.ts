// ===================================================================
// db.ts - Pusat koneksi database SQLite untuk NihonForge
// Semua fitur memanggil database lewat file ini.
// ===================================================================

import Database from "@tauri-apps/plugin-sql";
import { KOTOBA_SEED, AI_MODELS_SEED, PROMPTS_SEED, GRAMMAR_SEED, type KotobaSeed } from "./seed-data";
import PROGRESS_SEED from "./progress-seed.json";

let dbInstance: Database | null = null;

// Ambil koneksi database (dibuat sekali, lalu dipakai ulang)
export async function getDb(): Promise<Database> {
  if (!dbInstance) {
    dbInstance = await Database.load("sqlite:nihonforge-mobile.db");
  }
  return dbInstance;
}

// -------------------------------------------------------------------
// SEEDING: isi data awal kalau database masih kosong.
// Dipanggil sekali saat aplikasi pertama dibuka.
// -------------------------------------------------------------------
let seedPromise: Promise<void> | null = null;

// Cegah seeding ganda jika dipanggil 2x bersamaan (React StrictMode di mode dev)
export async function seedIfEmpty(): Promise<void> {
  if (seedPromise) return seedPromise;
  // Setelah seed, terapkan snapshot progress desktop (sekali saja, via marker).
  seedPromise = doSeed().then(() => applyProgressSeed());
  return seedPromise;
}

async function resyncAiModels(db: Database): Promise<void> {
  // Hapus semua model lama, ganti dengan seed terbaru
  const existing = await db.select<{ code: string }[]>("SELECT code FROM ai_models");
  const existingCodes = new Set(existing.map(r => r.code));
  const seedCodes = new Set(AI_MODELS_SEED.map(m => m.code));

  // Hapus model yang sudah tidak ada di seed
  for (const code of existingCodes) {
    if (!seedCodes.has(code)) {
      await db.execute("DELETE FROM ai_models WHERE code = $1", [code]);
    }
  }

  // Tambah model baru yang belum ada di DB
  for (const m of AI_MODELS_SEED) {
    if (!existingCodes.has(m.code)) {
      await db.execute(
        "INSERT INTO ai_models (name, code, note, provider) VALUES ($1, $2, $3, $4)",
        [m.name, m.code, m.note ?? "", m.provider]
      );
    }
  }
}

export async function doSeed(): Promise<void> {
  const db = await getDb();

  await db.execute(`CREATE TABLE IF NOT EXISTS grammar_chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number INTEGER NOT NULL,
    title TEXT NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS grammar_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chapter_id INTEGER NOT NULL,
    section_order INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    understood INTEGER NOT NULL DEFAULT 0
  )`);

  // Cek apakah tabel kotoba sudah berisi
  const rows = await db.select<{ c: number }[]>(
    "SELECT COUNT(*) as c FROM kotoba"
  );
  const count = rows[0]?.c ?? 0;

  if (count > 0) {
    await resyncAiModels(db);
    // Seed prompts kalau belum ada (existing DB skip bagian ini)
    const promptCount = await db.select<{ c: number }[]>("SELECT COUNT(*) as c FROM prompts");
    if ((promptCount[0]?.c ?? 0) === 0) {
      await db.execute("INSERT INTO prompts (key, value) VALUES ($1, $2)", ["listening", PROMPTS_SEED.listening]);
      await db.execute("INSERT INTO prompts (key, value) VALUES ($1, $2)", ["kotoba_gen", PROMPTS_SEED.kotoba_gen]);
      await db.execute("INSERT INTO prompts (key, value) VALUES ($1, $2)", ["kotoba_manual", PROMPTS_SEED.kotoba_manual]);
    }
    // SYNC KOTOBA: tambahkan kata dari seed yang belum ada di DB.
    // Row existing tidak disentuh -> progress hafalan (memorized) tetap aman.
    // Skip cepat: kalau seed sudah pernah di-sync (jumlah sama), lewati semua.
    const SEED_SYNC_VERSION = "kana-v1";
    const syncedMarker = await getSetting("kotoba_seed_synced");
    if (syncedMarker !== String(KOTOBA_SEED.length) + "-" + SEED_SYNC_VERSION) {
      const existing = await db.select<{ id: number; nihongo: string; kanji: string; imi: string; level: string; explanation: string }[]>(
        "SELECT id, nihongo, kanji, imi, level, explanation FROM kotoba"
      );
      const pairMap = new Map<string, number>();
      const dbLevelById = new Map<number, string>();
      const dbExpById = new Map<number, string>();
      const dbImiById = new Map<number, string>();
      for (const r of existing) {
        const key = r.nihongo + "\u0000" + (r.kanji || "-");
        if (!pairMap.has(key)) pairMap.set(key, r.id);
        dbLevelById.set(r.id, r.level || "GENERAL");
        dbExpById.set(r.id, r.explanation || "");
        dbImiById.set(r.id, r.imi || "");
      }
      // Backfill level untuk row existing yang level-nya beda dari seed
      // (row lama belum punya level -> default GENERAL dari migrasi)
      const levelUpdates = new Map<number, string>();
      for (const k of KOTOBA_SEED) {
        const kanji = (k.kanji || "").trim() || "-";
        const key = k.nihongo + "\u0000" + kanji;
        const id = pairMap.get(key);
        if (id !== undefined) {
          const seedLevel = (k.level || "GENERAL").trim() || "GENERAL";
          if ((dbLevelById.get(id) || "GENERAL") !== seedLevel) {
            levelUpdates.set(id, seedLevel);
          }
        }
      }
      const missing: KotobaSeed[] = [];
      for (const k of KOTOBA_SEED) {
        const kanji = (k.kanji || "").trim() || "-";
        const key = k.nihongo + "\u0000" + kanji;
        if (pairMap.has(key)) continue;
        pairMap.set(key, -1);
        missing.push({ ...k, kanji });
      }
      if (missing.length > 0) {
        // Insert per-chunk multi-row: 1 call IPC per ~100 kata (bukan per kata)
        const CHUNK = 100;
        for (let i = 0; i < missing.length; i += CHUNK) {
          const chunk = missing.slice(i, i + CHUNK);
          const params: (string | number)[] = [];
          const rows = chunk.map((k, j) => {
            const p = j * 7;
            params.push(k.nihongo, k.imi, k.kanji, k.explanation, k.level || "GENERAL", k.memorized ?? 0, k.memorized_kanji ?? 0);
            return `($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},$${p + 7})`;
          }).join(",");
          await db.execute(
            `INSERT INTO kotoba (nihongo, imi, kanji, explanation, level, memorized, memorized_kanji) VALUES ${rows}`,
            params
          );
        }
        console.log("Sync seed: " + missing.length + " kotoba baru ditambahkan.");
      }
      // Backfill level: update batch (CASE per id) supaya 1 call IPC per ~100 kata
      if (levelUpdates.size > 0) {
        const ids = Array.from(levelUpdates.keys());
        const CHUNK = 100;
        for (let i = 0; i < ids.length; i += CHUNK) {
          const chunkIds = ids.slice(i, i + CHUNK);
          const params: (string | number)[] = [];
          const cases = chunkIds.map((id, j) => {
            const p = j * 2;
            params.push(id, levelUpdates.get(id) || "GENERAL");
            return `WHEN $${p + 1} THEN $${p + 2}`;
          }).join(" ");
          const inParams = chunkIds.map((_, j) => `$${j * 2 + 1}`).join(",");
          await db.execute(
            `UPDATE kotoba SET level = CASE id ${cases} ELSE level END WHERE id IN (${inParams})`,
            params
          );
        }
        console.log("Sync seed: level di-backfill untuk " + levelUpdates.size + " kata.");
      }
      // Backfill explanation: overview saat seed diperbarui (mis. contoh
      // kalimat dilengkapi terjemahan). Row seed yang explanation-nya beda
      // dari DB di-update (chunk CASE, 1 call IPC per ~100 kata).
      // Explanation tidak bisa diedit user via UI, jadi aman mengikuti seed.
      const expUpdates = new Map<number, string>();
      for (const k of KOTOBA_SEED) {
        const kanji = (k.kanji || "").trim() || "-";
        const key = k.nihongo + "\u0000" + kanji;
        const id = pairMap.get(key);
        if (id !== undefined && id > 0) {
          const seedExp = k.explanation || "";
          if ((dbExpById.get(id) || "") !== seedExp) {
            expUpdates.set(id, seedExp);
          }
        }
      }
      if (expUpdates.size > 0) {
        const ids = Array.from(expUpdates.keys());
        const CHUNK = 100;
        for (let i = 0; i < ids.length; i += CHUNK) {
          const chunkIds = ids.slice(i, i + CHUNK);
          const params: (string | number)[] = [];
          const cases = chunkIds.map((id, j) => {
            const p = j * 2;
            params.push(id, expUpdates.get(id) || "");
            return `WHEN $${p + 1} THEN $${p + 2}`;
          }).join(" ");
          const inParams = chunkIds.map((_, j) => `$${j * 2 + 1}`).join(",");
          await db.execute(
            `UPDATE kotoba SET explanation = CASE id ${cases} ELSE explanation END WHERE id IN (${inParams})`,
            params
          );
        }
        console.log("Sync seed: explanation di-update untuk " + expUpdates.size + " kata.");
      }
      // Backfill imi (arti): update jika beda dari seed
      const imiUpdates = new Map<number, string>();
      for (const k of KOTOBA_SEED) {
        const kanji = (k.kanji || "").trim() || "-";
        const key = k.nihongo + "\u0000" + kanji;
        const id = pairMap.get(key);
        if (id !== undefined && id > 0) {
          const seedImi = k.imi || "";
          if ((dbImiById.get(id) || "") !== seedImi) {
            imiUpdates.set(id, seedImi);
          }
        }
      }
      if (imiUpdates.size > 0) {
        const ids = Array.from(imiUpdates.keys());
        const CHUNK = 100;
        for (let i = 0; i < ids.length; i += CHUNK) {
          const chunkIds = ids.slice(i, i + CHUNK);
          const params: (string | number)[] = [];
          const cases = chunkIds.map((id, j) => {
            const p = j * 2;
            params.push(id, imiUpdates.get(id) || "");
            return `WHEN $${p + 1} THEN $${p + 2}`;
          }).join(" ");
          const inParams = chunkIds.map((_, j) => `$${j * 2 + 1}`).join(",");
          await db.execute(
            `UPDATE kotoba SET imi = CASE id ${cases} ELSE imi END WHERE id IN (${inParams})`,
            params
          );
        }
        console.log("Sync seed: imi di-update untuk " + imiUpdates.size + " kata.");
      }
      await setSetting("kotoba_seed_synced", String(KOTOBA_SEED.length) + "-" + SEED_SYNC_VERSION);
    }
    // SYNC GRAMMAR: samakan bab & section dengan seed terbaru (hasil refinement AI).
    // Section yang belum ada di DB ditambahkan; judul/isi yang berubah di-update.
    // Kolom understood tidak disentuh -> progress "sudah paham" tetap aman.
    await syncGrammar(db);
    return;
  }

// Samakan tabel grammar_chapters/sections dengan GRAMMAR_SEED
async function syncGrammar(db: Database): Promise<void> {
  const chapters = await db.select<{ id: number; number: number; title: string }[]>(
    "SELECT id, number, title FROM grammar_chapters"
  );
  const chapterByNumber = new Map<number, number>();
  const chapterTitleById = new Map<number, string>();
  for (const c of chapters) {
    if (!chapterByNumber.has(c.number)) chapterByNumber.set(c.number, c.id);
    chapterTitleById.set(c.id, c.title);
  }
  const sections = await db.select<{ chapter_id: number; section_order: number; title: string; content: string }[]>(
    "SELECT chapter_id, section_order, title, content FROM grammar_sections"
  );
  const sectionByKey = new Map<string, { title: string; content: string }>();
  for (const s of sections) {
    sectionByKey.set(s.chapter_id + ":" + s.section_order, { title: s.title, content: s.content });
  }

  let added = 0;
  let updated = 0;
  for (const ch of GRAMMAR_SEED) {
    let chId = chapterByNumber.get(ch.number);
    if (chId === undefined) {
      const res = await db.execute(
        "INSERT INTO grammar_chapters (number, title) VALUES ($1, $2)",
        [ch.number, ch.title]
      );
      const newId = res.lastInsertId as number;
      chId = newId;
      chapterByNumber.set(ch.number, newId);
      for (let i = 0; i < ch.sections.length; i++) {
        const s = ch.sections[i];
        await db.execute(
          "INSERT INTO grammar_sections (chapter_id, section_order, title, content) VALUES ($1,$2,$3,$4)",
          [chId, i, s.title, s.content]
        );
      }
      added += ch.sections.length;
      continue;
    }
    if (chapterTitleById.get(chId) !== ch.title) {
      await db.execute("UPDATE grammar_chapters SET title = $1 WHERE id = $2", [ch.title, chId]);
      chapterTitleById.set(chId, ch.title);
      updated++;
    }
    for (let i = 0; i < ch.sections.length; i++) {
      const s = ch.sections[i];
      const key = chId + ":" + i;
      const existing = sectionByKey.get(key);
      if (existing === undefined) {
        sectionByKey.set(key, { title: s.title, content: s.content });
        await db.execute(
          "INSERT INTO grammar_sections (chapter_id, section_order, title, content) VALUES ($1,$2,$3,$4)",
          [chId, i, s.title, s.content]
        );
        added++;
      } else if (existing.title !== s.title || existing.content !== s.content) {
        existing.title = s.title;
        existing.content = s.content;
        await db.execute(
          "UPDATE grammar_sections SET title = $1, content = $2 WHERE chapter_id = $3 AND section_order = $4",
          [s.title, s.content, chId, i]
        );
        updated++;
      }
    }
  }
  console.log("Sync grammar: " + added + " section baru, " + updated + " update konten.");
}

  console.log("Database kosong, mulai mengisi data awal...");

  // --- Isi kotoba (chunk multi-row: 1 call IPC per ~100 kata, penting di HP) ---
  const CHUNK = 100;
  for (let i = 0; i < KOTOBA_SEED.length; i += CHUNK) {
    const chunk = KOTOBA_SEED.slice(i, i + CHUNK);
    const params: (string | number)[] = [];
    const rows = chunk.map((k, j) => {
      const p = j * 7;
      params.push(k.nihongo, k.imi, k.kanji, k.explanation, k.level || "GENERAL", k.memorized ?? 0, k.memorized_kanji ?? 0);
      return `($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},$${p + 7})`;
    }).join(",");
    await db.execute(
      `INSERT INTO kotoba (nihongo, imi, kanji, explanation, level, memorized, memorized_kanji) VALUES ${rows}`,
      params
    );
  }

  // --- Isi AI models ---
  for (const m of AI_MODELS_SEED) {
    await db.execute(
      "INSERT INTO ai_models (name, code, note, provider) VALUES ($1, $2, $3, $4)",
      [m.name, m.code, m.note ?? "", m.provider || "openrouter"]
    );
  }

  // --- Isi prompts ---
  await db.execute("INSERT INTO prompts (key, value) VALUES ($1, $2)", [
    "listening",
    PROMPTS_SEED.listening,
  ]);
  await db.execute("INSERT INTO prompts (key, value) VALUES ($1, $2)", [
    "kotoba_gen",
    PROMPTS_SEED.kotoba_gen,
  ]);
  await db.execute("INSERT INTO prompts (key, value) VALUES ($1, $2)", [
    "kotoba_manual",
    PROMPTS_SEED.kotoba_manual,
  ]);

// --- seed grammar (sinkron: insert jika baru, update jika sudah ada) ---
  await syncGrammar(db);

  console.log("Seeding selesai:", KOTOBA_SEED.length, "kotoba dimasukkan.");
}

// -------------------------------------------------------------------
// Tipe data kotoba (dipakai di banyak tempat)
// -------------------------------------------------------------------
export interface Kotoba {
  id: number;
  nihongo: string;
  imi: string;
  kanji: string;
  explanation: string;
  level: string;
  memorized: number;
  memorized_kanji: number;
}

// Hitung total kotoba di database
export async function countKotoba(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ c: number }[]>(
    "SELECT COUNT(*) as c FROM kotoba"
  );
  return rows[0]?.c ?? 0;
}

// Hitung total kotoba per level (untuk slider range yang level-aware)
export async function countKotobaByLevel(level: string): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ c: number }[]>(
    "SELECT COUNT(*) as c FROM kotoba WHERE level = $1",
    [level]
  );
  return rows[0]?.c ?? 0;
}

// Ambil kotoba berdasarkan rentang nomor urut (1-based, inklusif).
// Jika level != "all", range dihitung DALAM ruang level itu: baris
// level dipilih dulu (urut id), dinomori ulang dari 1, baru dipotong.
export async function getKotobaRange(
  start: number,
  end: number,
  level: string = "all"
): Promise<Kotoba[]> {
  const db = await getDb();
  if (level !== "all") {
    const all = await db.select<Kotoba[]>(
      "SELECT id, nihongo, imi, kanji, explanation, level, memorized, memorized_kanji FROM kotoba WHERE level = $1 ORDER BY id",
      [level]
    );
    const offset = Math.max(0, start - 1);
    const limit = end - start + 1;
    return all.slice(offset, offset + limit);
  }
  // LIMIT/OFFSET: ambil baris ke-(start) sampai (end)
  const limit = end - start + 1;
  const offset = start - 1;
  return await db.select<Kotoba[]>(
    "SELECT id, nihongo, imi, kanji, explanation, level, memorized, memorized_kanji FROM kotoba ORDER BY id LIMIT $1 OFFSET $2",
    [limit, offset]
  );
}

// -------------------------------------------------------------------
// DICTIONARY: pencarian kata (meniru logika VBA UserForm6)
// Cari di kolom nihongo & imi. Urutan prioritas:
//   1. cocok persis
//   2. cocok di awal
//   3. cocok sebagai kata terpisah / mengandung
// -------------------------------------------------------------------
export async function searchKotoba(keyword: string, level: string = "all"): Promise<Kotoba[]> {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return [];

  const db = await getDb();
  // Ambil semua baris yang mengandung keyword (di jepang, arti, ATAU kanji),
  // lalu urutkan relevansinya di sisi JavaScript.
  const like = `%${kw}%`;
  const rows = await db.select<Kotoba[]>(
    `SELECT id, nihongo, imi, kanji, explanation, level, memorized, memorized_kanji
       FROM kotoba
      WHERE LOWER(nihongo) LIKE $1 OR LOWER(imi) LIKE $1 OR LOWER(kanji) LIKE $1
      LIMIT 300`,
    [like]
  );
  const filtered = level === "all" ? rows : rows.filter((r) => (r.level || "GENERAL") === level);

  // Beri skor relevansi
  function score(k: Kotoba): number {
    const jp = (k.nihongo || "").toLowerCase();
    const id = (k.imi || "").toLowerCase();
    const kj = (k.kanji || "").toLowerCase();
    if (jp === kw || id === kw || kj === kw) return 0; // cocok persis
    if (jp.startsWith(kw) || id.startsWith(kw) || kj.startsWith(kw)) return 1; // cocok di awal
    // cocok sebagai kata terpisah (dipisah spasi atau /)
    const sep = /[ /]/;
    if (jp.split(sep).includes(kw) || id.split(sep).includes(kw) || kj.split(sep).includes(kw)) return 2;
    return 3; // sekadar mengandung
  }

  return filtered.sort((a, b) => score(a) - score(b));
}

// Ubah arti (imi) sebuah kata
export async function updateImi(id: number, newImi: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE kotoba SET imi = $1 WHERE id = $2", [newImi, id]);
}

// Hapus kata
export async function deleteKotoba(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM kotoba WHERE id = $1", [id]);
}

// Ambil semua kata (untuk layar All Kotoba Database)
export async function getAllKotoba(): Promise<Kotoba[]> {
  const db = await getDb();
  return await db.select<Kotoba[]>(
    "SELECT id, nihongo, imi, kanji, explanation, level, memorized, memorized_kanji FROM kotoba ORDER BY id"
  );
}

// -------------------------------------------------------------------
// HAFAL (memorized) toggle & count
// -------------------------------------------------------------------
export async function toggleMemorized(id: number, mode: "kana" | "kanji"): Promise<number> {
  const col = mode === "kanji" ? "memorized_kanji" : "memorized";
  const db = await getDb();
  await db.execute(
    `UPDATE kotoba SET ${col} = CASE WHEN ${col} = 1 THEN 0 ELSE 1 END WHERE id = $1`,
    [id]
  );
  const rows = await db.select<{ v: number }[]>(
    `SELECT ${col} as v FROM kotoba WHERE id = $1`, [id]
  );
  return rows[0]?.v ?? 0;
}

export async function countMemorizedKana(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ c: number }[]>(
    "SELECT COUNT(*) as c FROM kotoba WHERE memorized = 1"
  );
  return rows[0]?.c ?? 0;
}

export async function countMemorizedKanji(): Promise<number> {
  const db = await getDb();
  const all = await db.select<{ kanji: string; memorized_kanji: number }[]>(
    "SELECT kanji, memorized_kanji FROM kotoba"
  );
  // hitung hanya kata yang benar-benar punya kanji (populasi sama dengan countKanji)
  return all.filter((r) => punyaKanji(r.kanji) && r.memorized_kanji === 1).length;
}

// -------------------------------------------------------------------
// KOTOBA TEST: ambil rentang kata untuk dijadikan soal
// (mengembalikan pasangan soal Jepang + arti)
// -------------------------------------------------------------------
export interface SoalKotoba {
  jp: string;   // nihongo
  id: string;   // imi (arti)
  rowid: number; // database row id
  memorized: number; // status hafal
}

export async function getKotobaForTest(
  start: number,
  end: number,
  memFilter: "all" | "memorized" | "not_memorized" = "all",
  level: string = "all"
): Promise<SoalKotoba[]> {
  // Range dihitung dalam ruang level (level != "all" -> slice level dulu)
  let rows = await getKotobaRange(start, end, level);
  if (memFilter === "memorized") rows = rows.filter(r => r.memorized === 1);
  else if (memFilter === "not_memorized") rows = rows.filter(r => r.memorized === 0);
  return rows.map((r) => ({ jp: r.nihongo, id: r.imi, rowid: r.id, memorized: r.memorized }));
}

// -------------------------------------------------------------------
// KANJI TEST
// Berbeda dari Kotoba Test: nomor range dihitung HANYA dari daftar
// kata yang punya kanji. Jadi kata tanpa kanji ("-") dibuang dulu,
// daftar sisanya dinomori ulang dari 1, baru dipotong sesuai range.
// Contoh: range 1-20 = 20 kata berkanji pertama (PAS 20, bukan kurang).
// -------------------------------------------------------------------
export interface SoalKanji {
  kanji: string;   // soal yang ditampilkan (bentuk kanji)
  imi: string;     // jawaban benar (arti)
  nihongo: string; // kana / cara baca (untuk audio & catatan)
  rowid: number;   // database row id
  memorized: number; // status hafal kanji
}

// apakah sebuah nilai kolom kanji dianggap "punya kanji"?
function punyaKanji(kanji: string | null | undefined): boolean {
  const k = (kanji || "").trim();
  // buang yang kosong, tanda "-", atau garis panjang katakana "ー"
  return k !== "" && k !== "-" && k !== "ー";
}

// Hitung berapa banyak kata yang punya kanji (untuk batas maksimal input)
export async function countKanji(): Promise<number> {
  const db = await getDb();
  const all = await db.select<{ kanji: string }[]>("SELECT kanji FROM kotoba");
  return all.filter((r) => punyaKanji(r.kanji)).length;
}

// Hitung berapa banyak kata berkanji per level (untuk slider range level-aware)
export async function countKanjiByLevel(level: string): Promise<number> {
  const db = await getDb();
  const all = await db.select<{ kanji: string }[]>(
    "SELECT kanji FROM kotoba WHERE level = $1",
    [level]
  );
  return all.filter((r) => punyaKanji(r.kanji)).length;
}

export async function getKanjiForTest(
  start: number,
  end: number,
  memFilter: "all" | "memorized" | "not_memorized" = "all",
  level: string = "all"
): Promise<SoalKanji[]> {
  const db = await getDb();
  // 1) ambil semua kata terurut
  const all = await db.select<Kotoba[]>(
    "SELECT id, nihongo, imi, kanji, explanation, level, memorized, memorized_kanji FROM kotoba ORDER BY id"
  );
  // 2) saring hanya yang punya kanji (ini jadi "daftar bersih" bernomor 1..N)
  let kanjiWords = all.filter((r) => punyaKanji(r.kanji));
  if (level !== "all") kanjiWords = kanjiWords.filter(r => (r.level || "GENERAL") === level);
  // 3) potong sesuai range pada daftar bersih tersebut
  const offset = start - 1;
  const limit = end - start + 1;
  kanjiWords = kanjiWords.slice(offset, offset + limit);
  // 4) filter berdasarkan status hafal
  if (memFilter === "memorized") kanjiWords = kanjiWords.filter(r => r.memorized_kanji === 1);
  else if (memFilter === "not_memorized") kanjiWords = kanjiWords.filter(r => r.memorized_kanji === 0);
  return kanjiWords.map((r) => ({
    kanji: (r.kanji || "").trim(),
    imi: r.imi,
    nihongo: r.nihongo,
    rowid: r.id,
    memorized: r.memorized_kanji,
  }));
}

// -------------------------------------------------------------------
// HISTORY: simpan hasil sesi test
// -------------------------------------------------------------------
export async function saveHistory(
  rangeText: string,
  skor: number,
  mode: string
): Promise<void> {
  const db = await getDb();
  const tanggal = new Date().toISOString();
  await db.execute(
    "INSERT INTO history (tanggal, range_text, skor, mode) VALUES ($1, $2, $3, $4)",
    [tanggal, rangeText, skor, mode]
  );
}

export interface HistoryRow {
  id: number;
  tanggal: string;
  range_text: string;
  skor: number;
  mode: string;
}

export interface WrongWordRow {
  id: number;
  word: string;
  frekuensi: number;
}

export async function getHistory(): Promise<HistoryRow[]> {
  const db = await getDb();
  return await db.select<HistoryRow[]>(
    "SELECT id, tanggal, range_text, skor, mode FROM history ORDER BY id DESC LIMIT 300"
  );
}

export async function getWrongWords(): Promise<WrongWordRow[]> {
  const db = await getDb();
  return await db.select<WrongWordRow[]>(
    "SELECT id, word, frekuensi FROM wrong_words ORDER BY frekuensi DESC, id DESC LIMIT 100"
  );
}

export async function clearHistoryData(): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM history");
  await db.execute("DELETE FROM wrong_words");
}

// Catat kata yang sering salah (untuk analitik)
export async function recordWrongWord(word: string): Promise<void> {
  const db = await getDb();
  const existing = await db.select<{ id: number; frekuensi: number }[]>(
    "SELECT id, frekuensi FROM wrong_words WHERE word = $1",
    [word]
  );
  if (existing.length > 0) {
    await db.execute(
      "UPDATE wrong_words SET frekuensi = frekuensi + 1 WHERE id = $1",
      [existing[0].id]
    );
  } else {
    await db.execute(
      "INSERT INTO wrong_words (word, frekuensi) VALUES ($1, 1)",
      [word]
    );
  }
}

// Ambil progress kotoba terakhir (skor & range tertinggi) untuk label
export async function getLastKotobaProgress(): Promise<{ endRange: number; skor: number } | null> {
  const db = await getDb();
  const rows = await db.select<{ range_text: string; skor: number }[]>(
    `SELECT range_text, skor FROM history
      WHERE mode IN ('JtoI','ItoJ')
      ORDER BY id DESC LIMIT 50`
  );
  if (rows.length === 0) return null;
  // cari end-range tertinggi
  let best = { endRange: 0, skor: 0 };
  for (const r of rows) {
    const m = (r.range_text || "").match(/(\d+)\s*-\s*(\d+)/);
    const end = m ? parseInt(m[2], 10) : 0;
    if (end > best.endRange) best = { endRange: end, skor: r.skor };
  }
  return best.endRange > 0 ? best : null;
}

// Ambil progress kanji terakhir (skor & range tertinggi) untuk label
export async function getLastKanjiProgress(): Promise<{ endRange: number; skor: number } | null> {
  const db = await getDb();
  const rows = await db.select<{ range_text: string; skor: number }[]>(
    `SELECT range_text, skor FROM history
      WHERE mode = 'Kanji'
      ORDER BY id DESC LIMIT 50`
  );
  if (rows.length === 0) return null;
  let best = { endRange: 0, skor: 0 };
  for (const r of rows) {
    const m = (r.range_text || "").match(/(\d+)\s*-\s*(\d+)/);
    const end = m ? parseInt(m[2], 10) : 0;
    if (end > best.endRange) best = { endRange: end, skor: r.skor };
  }
  return best.endRange > 0 ? best : null;
}

// -------------------------------------------------------------------
// ADD KOTOBA MANUAL: helper untuk impor kata & prompt
// -------------------------------------------------------------------

// Ambil teks prompt berdasarkan key (untuk tombol PROMPT)
export async function getPrompt(key: string): Promise<string> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM prompts WHERE key = $1",
    [key]
  );
  return rows[0]?.value ?? "";
}

// Ambil peta "nihongo -> id" untuk cek duplikat dengan cepat
export async function getNihongoMap(): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db.select<{ id: number; nihongo: string }[]>(
    "SELECT id, nihongo FROM kotoba"
  );
  const map = new Map<string, number>();
  for (const r of rows) map.set((r.nihongo || "").trim(), r.id);
  return map;
}

// Tambah satu kata baru, kembalikan id baris baru
export async function insertKotoba(
  nihongo: string,
  imi: string,
  kanji: string,
  explanation: string
): Promise<number> {
  const db = await getDb();
  const res = await db.execute(
    "INSERT INTO kotoba (nihongo, imi, kanji, explanation) VALUES ($1, $2, $3, $4)",
    [nihongo, imi, kanji, explanation]
  );
  return (res.lastInsertId as number) ?? -1;
}

// Update kata yang sudah ada (berdasarkan id)
export async function updateKotobaFull(
  id: number,
  nihongo: string,
  imi: string,
  kanji: string,
  explanation: string
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE kotoba SET nihongo = $1, imi = $2, kanji = $3, explanation = $4 WHERE id = $5",
    [nihongo, imi, kanji, explanation, id]
  );
}

// Update satu field saja (dipakai kamus saat edit per-field).
// Untuk kanji: setiap kanji berubah (nilai baru != nilai lama), tanda
// "hafal kanji" (memorized_kanji) otomatis di-reset ke 0 dalam statement
// yang sama (atomik) supaya progress tidak pernah > 100%.
export type EditableKotobaField = "nihongo" | "imi" | "kanji";

export async function updateKotobaField(
  id: number,
  field: EditableKotobaField,
  value: string
): Promise<void> {
  const db = await getDb();
  if (field === "kanji") {
    const res = await db.execute(
      `UPDATE kotoba SET
         kanji = $1,
         memorized_kanji = CASE WHEN kanji IS NOT $1 THEN 0 ELSE memorized_kanji END
       WHERE id = $2`,
      [value, id]
    );
    if (res.rowsAffected !== 1) throw new Error("Data tidak ditemukan.");
    return;
  }
  if (field === "nihongo") {
    const res = await db.execute(
      "UPDATE kotoba SET nihongo = $1 WHERE id = $2",
      [value, id]
    );
    if (res.rowsAffected !== 1) throw new Error("Data tidak ditemukan.");
    return;
  }
  const res = await db.execute(
    "UPDATE kotoba SET imi = $1 WHERE id = $2",
    [value, id]
  );
  if (res.rowsAffected !== 1) throw new Error("Data tidak ditemukan.");
}

// -------------------------------------------------------------------
// SETTINGS umum: baca & simpan nilai apa pun (mis. API key)
// -------------------------------------------------------------------
// Retry otomatis kalau SQLite kena "database is locked" (code 5 / SQLITE_BUSY).
// Startup & drag slider bisa nembak banyak query bersamaan — tanpa ini,
// setSetting gagal diam-diam dan setting user hilang.
async function withBusyRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e);
      if (!msg.includes("database is locked") && !msg.includes("(code: 5)")) throw e;
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
  throw lastErr;
}

export async function getSetting(key: string): Promise<string> {
  return withBusyRetry(async () => {
    const db = await getDb();
    const rows = await db.select<{ value: string }[]>(
      "SELECT value FROM settings WHERE key = $1",
      [key]
    );
    return rows[0]?.value ?? "";
  });
}

export async function setSetting(key: string, value: string): Promise<void> {
  await withBusyRetry(async () => {
    const db = await getDb();
    await db.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2",
      [key, value]
    );
  });
}

// -------------------------------------------------------------------
// TARGET hafalan: simpan target kana & kanji di settings
// -------------------------------------------------------------------
export async function getTarget(mode: "kana" | "kanji"): Promise<number> {
  const key = mode === "kana" ? "kana_target" : "kanji_target";
  const val = await getSetting(key);
  const n = parseInt(val, 10);
  return isNaN(n) || n < 0 ? 0 : n;
}

export async function setTarget(mode: "kana" | "kanji", n: number): Promise<void> {
  const key = mode === "kana" ? "kana_target" : "kanji_target";
  await setSetting(key, String(Math.max(0, Math.round(n))));
}

// -------------------------------------------------------------------
// AI GENERATE: daftar model + kuota harian
// -------------------------------------------------------------------
export interface AiModel {
  name: string;
  code: string;
  note: string;
  provider: string;
}

export async function getAiModels(provider?: string): Promise<AiModel[]> {
  const db = await getDb();
  if (provider) {
    return await db.select<AiModel[]>(
      "SELECT name, code, note, provider FROM ai_models WHERE provider = $1 ORDER BY id", [provider]
    );
  }
  return await db.select<AiModel[]>("SELECT name, code, note, provider FROM ai_models ORDER BY id");
}

export function getAiEndpoint(provider: string): string {
  switch (provider) {
    case "opencode": return "https://opencode.ai/zen/v1/chat/completions";
    case "groq":     return "https://api.groq.com/openai/v1/chat/completions";
    default:         return "https://openrouter.ai/api/v1/chat/completions";
  }
}

export async function getAiKey(provider: string): Promise<string> {
  let key: string;
  switch (provider) {
    case "opencode": key = "api_key_zen"; break;
    case "groq":     key = "api_key_groq"; break;
    default:         key = "api_key"; break;
  }
  return (await getSetting(key)).trim();
}

const MAX_DAILY_QUOTA = 1500;

// kuota harian sederhana: reset tiap ganti hari
export async function getRemainingQuota(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const savedDate = await getSetting("quota_date");
  if (savedDate !== today) {
    await setSetting("quota_date", today);
    await setSetting("quota_used", "0");
    return MAX_DAILY_QUOTA;
  }
  const used = parseInt((await getSetting("quota_used")) || "0", 10);
  return Math.max(0, MAX_DAILY_QUOTA - used);
}

export async function addQuotaUsed(n: number): Promise<void> {
  const used = parseInt((await getSetting("quota_used")) || "0", 10);
  await setSetting("quota_used", String(used + n));
}

export const QUOTA_MAX = MAX_DAILY_QUOTA;

// Hapus satu baris history (satu sesi) berdasarkan id
export async function deleteHistoryRow(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM history WHERE id = $1", [id]);
}

// Ambil rentang kata yang PUNYA kanji sebagai objek Kotoba penuh
// (untuk Flashcard mode kanji). Range dihitung dari daftar kanji-only,
// jadi range 1-20 = 20 kanji (kata non-kanji dilewati saat menghitung).
// Jika level != "all", range dihitung DALAM ruang level itu.
export async function getKanjiKotobaRange(
  start: number,
  end: number,
  level: string = "all"
): Promise<Kotoba[]> {
  const db = await getDb();
  const all = await db.select<Kotoba[]>(
    "SELECT id, nihongo, imi, kanji, explanation, level, memorized, memorized_kanji FROM kotoba ORDER BY id"
  );
  let kanjiWords = all.filter((r) => {
    const k = (r.kanji || "").trim();
    return k !== "" && k !== "-" && k !== "ー";
  });
  if (level !== "all") kanjiWords = kanjiWords.filter((r) => (r.level || "GENERAL") === level);
  const offset = Math.max(0, start - 1);
  const limit = end - start + 1;
  return kanjiWords.slice(offset, offset + limit);
}

// ===== GRAMMAR =====
export interface GChapter { id: number; number: number; title: string; total: number; done: number; }
export interface GSection { id: number; chapter_id: number; section_order: number; title: string; content: string; understood: number; }

export async function getGrammarChapters(): Promise<GChapter[]> {
  const db = await getDb();
  return db.select<GChapter[]>(`
    SELECT c.id, c.number, c.title,
      COUNT(s.id) as total,
      SUM(s.understood) as done
    FROM grammar_chapters c
    LEFT JOIN grammar_sections s ON s.chapter_id = c.id
    GROUP BY c.id ORDER BY c.number
  `);
}

export async function getGrammarSections(chapterId: number): Promise<GSection[]> {
  const db = await getDb();
  return db.select<GSection[]>(
    "SELECT * FROM grammar_sections WHERE chapter_id = $1 ORDER BY section_order",
    [chapterId]
  );
}

export async function setGrammarUnderstood(sectionId: number, val: number): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE grammar_sections SET understood = $1 WHERE id = $2", [val, sectionId]);
}

export async function getGrammarTotalProgress(): Promise<{ total: number; done: number }> {
  const db = await getDb();
  const r = await db.select<[{ total: number; done: number }]>(
    "SELECT COUNT(*) as total, SUM(understood) as done FROM grammar_sections"
  );
  return { total: r[0].total, done: r[0].done || 0 };
}

// ===== BACKUP =====
export async function backupKotobaToFile(): Promise<string | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  const db = await getDb();
  const rows = await db.select<Kotoba[]>(
    "SELECT nihongo, imi, kanji, explanation, level, memorized, memorized_kanji FROM kotoba ORDER BY id"
  );
  const json = JSON.stringify(rows, null, 2);
  const date = new Date().toISOString().slice(0, 10);
  const filename = "nihonforge-backup-" + date + ".json";
  const path = await invoke<string | null>("pick_save_path", { filename });
  if (!path) return null; // user cancel
  await invoke("save_backup", { path, content: json });
  return path;
}

export async function restoreKotobaFromFile(): Promise<{ added: number; updated: number }> {
  const { invoke } = await import("@tauri-apps/api/core");
  const path = await invoke<string | null>("pick_restore_file");
  if (!path) return { added: 0, updated: -1 }; // user cancel
  const content = await invoke<string>("read_file", { path });
  const rows: Kotoba[] = JSON.parse(content);
  const db = await getDb();
  // Index pasangan kana+kanji: homonim (kana sama, kanji beda) dianggap
  // kata yang berbeda, jadi masing-masing dapat barisnya sendiri.
  const existing = await db.select<{ id: number; nihongo: string; kanji: string }[]>(
    "SELECT id, nihongo, kanji FROM kotoba"
  );
  const pairMap = new Map<string, number>();
  for (const r of existing) {
    const key = r.nihongo + "\u0000" + (r.kanji || "-");
    if (!pairMap.has(key)) pairMap.set(key, r.id);
  }
  let added = 0, updated = 0;
  for (const r of rows) {
    const kanji = r.kanji || "-";
    const mem = (r as any).memorized ?? 0;
    const memK = (r as any).memorized_kanji ?? 0;
    const lvl = (r as any).level || "GENERAL";
    const existingId = pairMap.get(r.nihongo + "\u0000" + kanji);
    if (existingId !== undefined) {
      await db.execute(
        "UPDATE kotoba SET imi=$1, kanji=$2, explanation=$3, level=$4, memorized=$5, memorized_kanji=$6 WHERE id=$7",
        [r.imi, kanji, r.explanation || "", lvl, mem, memK, existingId]
      );
      updated++;
    } else {
      await db.execute(
        "INSERT INTO kotoba (nihongo, imi, kanji, explanation, level, memorized, memorized_kanji) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [r.nihongo, r.imi, kanji, r.explanation || "", lvl, mem, memK]
      );
      added++;
    }
  }
  return { added, updated };
}

// -------------------------------------------------------------------
// PROGRESS SEED (mobile only): terapkan snapshot hafalan desktop sekali.
// Sumber: src/progress-seed.json (hasil ekstrak DB produksi, key = pasangan
// nihongo+kanji sehingga tahan terhadap geser id). Dijalankan via
// seedIfEmpty(); penanda `progress_applied` mencegah jalan dua kali.
// -------------------------------------------------------------------
interface ProgressSeed {
  extracted_at: string;
  flags: [string, string, number, number][];
  extra: { nihongo: string; imi: string; kanji: string; explanation: string; level: string; memorized: number; memorized_kanji: number }[];
}

async function applyProgressSeed(): Promise<void> {
  try {
    const seed = PROGRESS_SEED as unknown as ProgressSeed;
    if (!seed || !seed.extracted_at) return;
    if ((await getSetting("progress_applied")) === seed.extracted_at) return;
    const db = await getDb();

    // 1) Kata tambahan user (tidak ada di seed): INSERT bila belum ada.
    for (const w of seed.extra) {
      const kanji = (w.kanji || "").trim() || "-";
      const hit = await db.select<{ id: number }[]>(
        "SELECT id FROM kotoba WHERE nihongo = $1 AND kanji = $2 LIMIT 1",
        [w.nihongo, kanji]
      );
      if (hit.length === 0) {
        await db.execute(
          "INSERT INTO kotoba (nihongo, imi, kanji, explanation, level, memorized, memorized_kanji) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [w.nihongo, w.imi, kanji, w.explanation || "", w.level || "GENERAL", w.memorized ?? 0, w.memorized_kanji ?? 0]
        );
      }
    }

    // 2) Flags hafalan: petakan pasangan -> id, lalu UPDATE batch (CASE per 200).
    const all = await db.select<{ id: number; nihongo: string; kanji: string }[]>(
      "SELECT id, nihongo, kanji FROM kotoba"
    );
    const idByPair = new Map<string, number>();
    for (const r of all) {
      const key = r.nihongo + " " + (r.kanji || "-");
      if (!idByPair.has(key)) idByPair.set(key, r.id);
    }
    const updates: [number, number, number][] = [];
    for (const [n, k, mem, memK] of seed.flags) {
      const id = idByPair.get(n + " " + ((k || "").trim() || "-"));
      if (id !== undefined) updates.push([id, mem, memK]);
    }
    const CHUNK = 200;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const ch = updates.slice(i, i + CHUNK);
      const params: (string | number)[] = ch.map(([id]) => id);
      let p = params.length + 1;
      const memWhens: string[] = [];
      const memKWhens: string[] = [];
      for (const [id, mem, memK] of ch) {
        memWhens.push(`WHEN $${p} THEN $${p + 1}`);
        params.push(id, mem);
        p += 2;
        memKWhens.push(`WHEN $${p} THEN $${p + 1}`);
        params.push(id, memK);
        p += 2;
      }
      const inList = ch.map((_, j) => `$${j + 1}`).join(",");
      await db.execute(
        `UPDATE kotoba SET memorized = CASE id ${memWhens.join(" ")} ELSE memorized END, ` +
        `memorized_kanji = CASE id ${memKWhens.join(" ")} ELSE memorized_kanji END ` +
        `WHERE id IN (${inList})`,
        params
      );
    }
    await setSetting("progress_applied", seed.extracted_at);
    console.log(`Progress seed diterapkan: ${updates.length} flags, ${seed.extra.length} kata tambahan.`);
  } catch (e) {
    // Jangan blokir boot kalau snapshot gagal (mis. DB desktop berubah format).
    console.warn("applyProgressSeed gagal, lanjut tanpa snapshot:", e);
  }
}