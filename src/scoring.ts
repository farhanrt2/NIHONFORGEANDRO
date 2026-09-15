// ===================================================================
// scoring.ts - Logika cek jawaban Kotoba Test (meniru VBA CommandButton2)
// Pencocokan "pintar": tidak harus persis 100%.
// ===================================================================

// Bersihkan arti: hapus teks dalam kurung, ganti / ; jadi koma, rapikan spasi
// (meniru CleanMeaning di VBA)
export function cleanMeaning(text: string): string {
  let result = text || "";
  // hapus segala "(...)"
  while (result.includes("(")) {
    const s = result.indexOf("(");
    const e = result.indexOf(")");
    if (e > s) {
      result = result.slice(0, s) + result.slice(e + 1);
    } else {
      break;
    }
  }
  result = result.replace(/\//g, ",").replace(/;/g, ",");
  while (result.includes("  ")) result = result.replace(/  /g, " ");
  return result.trim();
}

// Normalisasi jawaban user
function normalize(s: string): string {
  let u = (s || "").trim().toLowerCase();
  u = u.replace(/\//g, " ").replace(/,/g, " ").replace(/;/g, " ");
  while (u.includes("  ")) u = u.replace(/  /g, " ");
  return u.trim();
}

/**
 * Cek apakah jawaban user benar terhadap jawaban target.
 * @param userInput jawaban yang diketik user
 * @param target jawaban benar (arti, atau kata jepang tergantung mode)
 */
export function checkAnswer(userInput: string, target: string): boolean {
  const userAnswer = normalize(userInput);
  if (!userAnswer) return false;

  const targetClean = cleanMeaning(target);
  if (!targetClean) return false;

  const keywords = targetClean.split(",");

  for (let keyword of keywords) {
    keyword = normalize(keyword);
    if (!keyword) continue;

    // cocok persis, atau salah satu mengandung yang lain
    if (
      userAnswer === keyword ||
      keyword.includes(userAnswer) ||
      userAnswer.includes(keyword)
    ) {
      return true;
    }

    // cocok sebagian kata (kata penting > 2 huruf), dan kata pertama harus ada
    const dbWords = keyword.split(" ");
    let matchCount = 0;
    let totalWords = 0;
    for (const w of dbWords) {
      if (w.trim().length > 2) {
        totalWords++;
        if (userAnswer.includes(w.trim())) matchCount++;
      }
    }
    if (totalWords > 0 && matchCount >= 1) {
      if (userAnswer.includes(dbWords[0].trim())) return true;
    }
  }

  return false;
}
