// ============================================================
// crypto.js — Modul Enkripsi Ringan untuk Luau Obfuscator
// JavaScript murni — berjalan di Delta Executor / Node.js / Roblox bridge
// ============================================================
// Menyediakan:
//   - XOR cipher untuk enkripsi string
//   - ROT enkripsi nama identifier
//   - Enkripsi angka (obfuskasi literal numerik)
//   - Fungsi bantu: generateKey, encryptString, decryptString, obfuscateNumber
//   - Runtime decoder yang di-emit ke dalam output Luau (sebagai string)
// ============================================================

"use strict";

const LuauCrypto = (function () {

  // -------------------------------------------------------
  // 1. Pembuat kunci
  // -------------------------------------------------------

  /**
   * Hasilkan kunci byte acak panjang `len`.
   * rng: fungsi yang mengembalikan float [0,1) — dari ObfuscatorOptions._rng
   */
  function generateKey(len, rng) {
    len = len || 8;
    const key = [];
    for (let i = 0; i < len; i++) {
      // kunci harus 1-255 (hindari 0 agar XOR tidak trivial)
      key.push(1 + Math.floor(rng.next() * 254));
    }
    return key; // array of integers
  }

  // -------------------------------------------------------
  // 2. XOR enkripsi string
  // -------------------------------------------------------

  /**
   * Enkripsi string `str` dengan key (array of int).
   * Kembalikan array byte integer (encrypted).
   */
  function encryptString(str, key) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i) & 0xFF;
      bytes.push(code ^ key[i % key.length]);
    }
    return bytes; // array integer
  }

  /**
   * Dekripsi — operasi sama (XOR simetris).
   */
  function decryptString(bytes, key) {
    let result = "";
    for (let i = 0; i < bytes.length; i++) {
      result += String.fromCharCode(bytes[i] ^ key[i % key.length]);
    }
    return result;
  }

  /**
   * Ubah array byte integer menjadi tabel Luau literal string.
   * Contoh output: {72,101,108,108,111}
   */
  function bytesToLuaTable(bytes) {
    return "{" + bytes.join(",") + "}";
  }

  /**
   * Ubah array kunci integer menjadi tabel Luau literal string.
   */
  function keyToLuaTable(key) {
    return "{" + key.join(",") + "}";
  }

  // -------------------------------------------------------
  // 3. Obfuskasi angka
  // -------------------------------------------------------

  /**
   * Ubah angka n menjadi ekspresi Luau yang bernilai sama.
   * Strategi: n = (a + b) * c - d, semuanya acak.
   * Kembalikan string ekspresi Luau.
   */
  function obfuscateNumber(n, rng) {
    if (!isFinite(n) || isNaN(n)) return String(n);
    if (n === 0) {
      const a = rng.nextInt(1, 500);
      return "(" + a + "-" + a + ")";
    }
    // Pilih strategi: 0=add/sub, 1=mul/div, 2=bitops (hanya int)
    const strategy = rng.nextInt(0, 2);
    const isInt = (n === Math.floor(n)) && Math.abs(n) < 2147483647;

    if (strategy === 0) {
      // n = (n + offset) - offset
      const offset = rng.nextInt(1, 9999);
      if (n >= 0) {
        return "((" + (n + offset) + ")-" + offset + ")";
      } else {
        return "((" + (n - offset) + ")+" + offset + ")";
      }
    } else if (strategy === 1 && n !== 0) {
      // n = (n * factor) / factor
      const factor = rng.nextInt(2, 9);
      return "((" + (n * factor) + ")/" + factor + ")";
    } else if (strategy === 2 && isInt) {
      // n = (n ~ 0) — bit XOR with 0 is identity in Luau bit32
      const mask = rng.nextInt(1, 0xFF);
      return "(bit32.bxor(bit32.bxor(" + n + "," + mask + ")," + mask + "))";
    }
    // fallback
    return String(n);
  }

  // -------------------------------------------------------
  // 4. Runtime decoder (kode Luau yang di-emit ke dalam output)
  // -------------------------------------------------------

  /**
   * Kembalikan potongan kode Luau (sebagai string JS) yang mendefinisikan
   * fungsi decoder di dalam skrip yang di-obfuskasi.
   *
   * Parameter:
   *   decoderName  — nama fungsi decoder (sudah di-obfuskasi, mis. "_0xabc1")
   *   keyVarName   — nama variabel kunci Luau (mis. "_0xkey1")
   *   keyTable     — string tabel Luau seperti "{72,101,15}"
   *
   * Output Luau yang di-emit kira-kira:
   *   local _0xkey1 = {72,101,15}
   *   local function _0xabc1(t)
   *     local r = ""
   *     for i = 1, #t do
   *       r = r .. string.char(bit32.bxor(t[i], _0xkey1[((i-1) % #_0xkey1) + 1]))
   *     end
   *     return r
   *   end
   */
  function emitLuauDecoder(decoderName, keyVarName, keyTable) {
    return (
      "local " + keyVarName + " = " + keyTable + "\n" +
      "local function " + decoderName + "(t)\n" +
      "  local r = \"\"\n" +
      "  local k = " + keyVarName + "\n" +
      "  for i = 1, #t do\n" +
      "    r = r .. string.char(bit32.bxor(t[i], k[((i-1) % #k) + 1]))\n" +
      "  end\n" +
      "  return r\n" +
      "end\n"
    );
  }

  /**
   * Emit kode Luau untuk memanggil decoder dengan byte literal.
   * Contoh: _0xabc1({72,101,108,108,111})
   */
  function emitDecodeCall(decoderName, bytes) {
    return decoderName + "(" + bytesToLuaTable(bytes) + ")";
  }

  // -------------------------------------------------------
  // 5. Hash sederhana (untuk menghasilkan nama deterministik)
  // -------------------------------------------------------

  /**
   * Hash string menjadi integer 32-bit (djb2 sederhana).
   */
  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h) ^ s.charCodeAt(i);
      h = h >>> 0; // unsigned 32
    }
    return h;
  }

  /**
   * Hasilkan nama identifier ter-obfuskasi dari string asli + seed.
   * prefix: mis. "_0x"
   */
  function makeObfName(original, seed, prefix) {
    prefix = prefix || "_0x";
    const h = (hashStr(original) ^ (seed >>> 0)) >>> 0;
    return prefix + h.toString(16).padStart(8, "0");
  }

  // -------------------------------------------------------
  // API publik
  // -------------------------------------------------------

  return {
    generateKey:       generateKey,
    encryptString:     encryptString,
    decryptString:     decryptString,
    bytesToLuaTable:   bytesToLuaTable,
    keyToLuaTable:     keyToLuaTable,
    obfuscateNumber:   obfuscateNumber,
    emitLuauDecoder:   emitLuauDecoder,
    emitDecodeCall:    emitDecodeCall,
    hashStr:           hashStr,
    makeObfName:       makeObfName,
  };

})();

// ---- Ekspor ----
if (typeof module !== "undefined" && module.exports) {
  module.exports = LuauCrypto;
}
if (typeof globalThis !== "undefined") {
  globalThis.LuauCrypto = LuauCrypto;
}
