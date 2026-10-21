// ============================================================
// options.js — Konfigurasi Obfuscator Luau
// JavaScript murni — berjalan di Delta Executor / Node.js / Roblox bridge
// ============================================================
// Berisi semua pilihan yang mengontrol proses obfuskasi.
// Setiap pass (compiler, opt, semantics, irverify, crypto)
// membaca opsi dari objek ObfuscatorOptions.
// ============================================================

"use strict";

const ObfuscatorOptions = (function () {

  // ---- Nilai default ----
  const DEFAULTS = {
    // --- Nama & identitas ---
    // Ganti semua nama variabel/fungsi/parameter dengan nama acak
    renameVariables: true,
    // Ganti nama global yang aman (tidak wajib, off = aman untuk Roblox API)
    renameGlobals: false,
    // Prefix nama yang di-rename (default: '_0x')
    renamePrefix: "_0x",

    // --- String ---
    // Enkripsi string literal (XOR sederhana)
    encryptStrings: true,
    // Pecah string panjang menjadi konkatenasi potongan
    splitStrings: true,
    // Panjang maksimum potongan string saat splitStrings aktif
    splitStringsChunkSize: 4,

    // --- Angka ---
    // Acak literal angka menjadi ekspresi aritmetika yang hasilnya sama
    encryptNumbers: true,

    // --- Alur kontrol (Control flow) ---
    // Tambahkan blok if palsu / dead code
    addDeadCode: true,
    // Acak urutan pernyataan (safe: hanya pernyataan yang tidak saling tergantung)
    shuffleStatements: false,
    // Tambahkan garbage statement (panggilan fiktif yang tidak berpengaruh)
    addGarbage: true,
    // Tingkat garbage: 0-3 (0=tidak ada, 3=sangat banyak)
    garbageLevel: 1,

    // --- VM / bytecode protection ---
    // Bungkus output di dalam mini-VM (paling kuat, paling lambat)
    useVM: true,
    // Ukuran kunci VM (8 atau 16)
    vmKeySize: 8,

    // --- Obfuskasi tabel ---
    // Ubah akses `t.key` menjadi `t["key"]` dengan nama dienkripsi
    obfuscateTableKeys: true,

    // --- Whitespace & format ---
    // Hapus semua komentar
    removeComments: true,
    // Minifikasi (hapus whitespace dan newline tidak perlu)
    minify: true,

    // --- Opsi lanjutan ---
    // Seed acak untuk hasil deterministik (null = benar-benar acak)
    seed: null,
    // Nama variabel yang TIDAK boleh di-rename (whitelist)
    globalWhitelist: [
      "game", "workspace", "script", "require", "print", "warn", "error",
      "tostring", "tonumber", "type", "typeof", "pcall", "xpcall", "ipairs",
      "pairs", "next", "select", "unpack", "table", "string", "math",
      "bit32", "utf8", "os", "task", "coroutine", "Vector3", "CFrame",
      "Instance", "Enum", "Color3", "UDim", "UDim2", "Region3",
    ],

    // --- Debugging ---
    // Sertakan source map di output (komentar tersembunyi)
    sourceMap: false,
    // Verbose: cetak log tiap pass ke console
    verbose: false,
  };

  // ---- Konstruktor ----
  function ObfuscatorOptions(userOpts) {
    // Salin default
    for (const k in DEFAULTS) {
      this[k] = DEFAULTS[k];
    }
    // Override dengan pilihan pengguna
    if (userOpts && typeof userOpts === "object") {
      for (const k in userOpts) {
        if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) {
          this[k] = userOpts[k];
        }
        // Abaikan kunci yang tidak dikenal (aman)
      }
    }
    // Inisialisasi RNG
    this._seed = (this.seed !== null && this.seed !== undefined)
      ? Number(this.seed)
      : Math.floor(Math.random() * 0xFFFFFFFF);
    this._rng = createRNG(this._seed);
  }

  // ---- RNG deterministik (xorshift32) ----
  function createRNG(seed) {
    let s = (seed >>> 0) || 1;
    return {
      next: function () {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        return (s >>> 0) / 0x100000000;
      },
      nextInt: function (min, max) {
        return min + Math.floor(this.next() * (max - min + 1));
      },
      nextId: function (prefix, len) {
        prefix = prefix || "_0x";
        len = len || 8;
        let id = prefix;
        const HEX = "0123456789abcdef";
        for (let i = 0; i < len; i++) {
          id += HEX[Math.floor(this.next() * 16)];
        }
        return id;
      },
      shuffle: function (arr) {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = this.nextInt(0, i);
          const tmp = arr[i];
          arr[i] = arr[j];
          arr[j] = tmp;
        }
        return arr;
      }
    };
  }

  // ---- Metode bantu ----
  ObfuscatorOptions.prototype.isWhitelisted = function (name) {
    if (!this.renameGlobals) return false; // mode aman
    return this.globalWhitelist.indexOf(name) !== -1;
  };

  ObfuscatorOptions.prototype.rng = function () {
    return this._rng;
  };

  ObfuscatorOptions.prototype.clone = function () {
    const c = new ObfuscatorOptions(this);
    c._seed = this._seed;
    c._rng  = createRNG(this._seed);
    return c;
  };

  ObfuscatorOptions.DEFAULTS = DEFAULTS;
  ObfuscatorOptions.createRNG = createRNG;

  return ObfuscatorOptions;
})();

// ---- Ekspor ----
if (typeof module !== "undefined" && module.exports) {
  module.exports = ObfuscatorOptions;
}
if (typeof globalThis !== "undefined") {
  globalThis.ObfuscatorOptions = ObfuscatorOptions;
}
