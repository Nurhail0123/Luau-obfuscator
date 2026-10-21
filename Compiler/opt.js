// ============================================================
// opt.js — Pass Optimisasi / Obfuskasi AST untuk Luau Obfuscator
// JavaScript murni — berjalan di Delta Executor / Node.js / Roblox bridge
// ============================================================
// Pass-pass yang tersedia:
//   1. renameLocals       — ganti nama local/param dengan nama acak
//   2. encryptStrings     — enkripsi string literal
//   3. encryptNumbers     — obfuskasi angka menjadi ekspresi
//   4. obfuscateTableKeys — ubah t.key menjadi t["<encoded>"]
//   5. addGarbage         — sisipkan pernyataan sampah yang aman
//   6. addDeadCode        — sisipkan blok dead code yang tidak pernah jalan
//   7. shuffleStatements  — acak urutan pernyataan yang aman
//
// Setiap pass adalah fungsi: pass(ast, symbolTable, crypto, opts) -> void
// Memodifikasi AST in-place.
// ============================================================

"use strict";

const LuauOpt = (function () {

  // -------------------------------------------------------
  // PASS 1 — Rename Local Variables
  // -------------------------------------------------------

  function renameLocals(ast, symbolTable, crypto, opts) {
    if (!opts.renameVariables) return;
    const rng    = opts.rng();
    const prefix = opts.renamePrefix || "_0x";
    const usedNames = new Set();

    function freshName() {
      let name;
      do {
        name = prefix + rng.nextInt(0x10000, 0xFFFFFF).toString(16);
      } while (usedNames.has(name));
      usedNames.add(name);
      return name;
    }

    // Tetapkan nama baru untuk semua simbol yang boleh di-rename
    const allSyms = symbolTable.allSyms;
    for (let i = 0; i < allSyms.length; i++) {
      const sym = allSyms[i];
      if (sym.canRename && sym.kind !== "global") {
        sym.renameTo = freshName();
      }
    }

    // Perbarui semua node Identifier yang punya referensi simbol
    for (let i = 0; i < allSyms.length; i++) {
      const sym = allSyms[i];
      if (!sym.renameTo) continue;
      for (let j = 0; j < sym.refs.length; j++) {
        sym.refs[j].name = sym.renameTo;
      }
      // Juga nama pada node deklarasi jika ada
      if (sym.node && sym.node.name && sym.node.type === "Identifier") {
        sym.node.name = sym.renameTo;
      }
    }
  }

  // -------------------------------------------------------
  // PASS 2 — Enkripsi String
  // -------------------------------------------------------

  function encryptStrings(ast, symbolTable, crypto, opts) {
    if (!opts.encryptStrings) return;
    const rng = opts.rng();

    // Satu decoder per run
    const keyArr  = crypto.generateKey(opts.vmKeySize || 8, rng);
    const keyVar  = "_k" + rng.nextInt(0x1000, 0xFFFF).toString(16);
    const decName = "_d" + rng.nextInt(0x1000, 0xFFFF).toString(16);

    // Simpan metadata di AST agar compiler bisa emit decoder
    if (!ast._obfMeta) ast._obfMeta = {};
    ast._obfMeta.strDecoder = {
      decoderName: decName,
      keyVarName:  keyVar,
      keyTable:    crypto.keyToLuaTable(keyArr),
      key:         keyArr,
    };

    // Walk AST dan ganti StringLiteral
    walkAST(ast, function (node, parent, key, idx) {
      if (node.type !== "StringLiteral") return;
      // Jangan enkripsi jika ini kunci tabel di MemberExpression non-computed
      if (parent && parent.type === "MemberExpression" && !parent.computed) return;
      // Jangan enkripsi string kosong
      if (!node.value) return;

      const bytes = crypto.encryptString(node.value, keyArr);
      // Ubah menjadi CallExpression node buatan
      const callNode = {
        type:      "CallExpression",
        callee:    { type: "Identifier", name: decName },
        method:    null,
        kind:      "call",
        arguments: [{
          type:   "TableConstructorExpression",
          fields: bytes.map(function (b) {
            return { kind: "array", value: { type: "NumberLiteral", value: b, raw: String(b) } };
          })
        }],
        _obfEncStr: true,
        line:   node.line,
        column: node.column,
      };

      // Ganti node in-place
      if (parent && key !== null) {
        if (idx !== null) {
          parent[key][idx] = callNode;
        } else {
          parent[key] = callNode;
        }
      }
    });
  }

  // -------------------------------------------------------
  // PASS 3 — Obfuskasi Angka
  // -------------------------------------------------------

  function encryptNumbers(ast, symbolTable, crypto, opts) {
    if (!opts.encryptNumbers) return;
    const rng = opts.rng();

    walkAST(ast, function (node, parent, key, idx) {
      if (node.type !== "NumberLiteral") return;
      const n = node.value;
      if (!isFinite(n)) return;
      // Hasilkan ekspresi Luau obfuskasi sebagai string, lalu simpan di node
      const expr = crypto.obfuscateNumber(n, rng);
      node._obfExpr = expr; // compiler akan emit expr ini
    });
  }

  // -------------------------------------------------------
  // PASS 4 — Obfuskasi Kunci Tabel
  // -------------------------------------------------------

  function obfuscateTableKeys(ast, symbolTable, crypto, opts) {
    if (!opts.obfuscateTableKeys) return;
    const rng = opts.rng();

    walkAST(ast, function (node, parent, key, idx) {
      if (node.type !== "MemberExpression") return;
      if (node.computed) return; // sudah t["key"]
      // Ubah t.key menjadi t["key"]
      node.computed = true;
      // node.property harus StringLiteral dengan value = nama property
      if (node.property && node.property.type === "StringLiteral") {
        // Sudah benar
      } else if (node.property && node.property.type === "Identifier") {
        node.property = {
          type: "StringLiteral",
          value: node.property.name,
          raw: '"' + node.property.name + '"',
        };
      }
    });
  }

  // -------------------------------------------------------
  // PASS 5 — Tambah Garbage Statements
  // -------------------------------------------------------

  const GARBAGE_TEMPLATES = [
    // local throwaway = math.huge * 0
    function (rng) {
      const name = "_g" + rng.nextInt(0x100, 0xFFFF).toString(16);
      return {
        type: "LocalStatement",
        names: [{ type: "Identifier", name: name }],
        init:  [{
          type: "BinaryExpression",
          operator: "*",
          left:  { type: "NumberLiteral", value: Math.floor(rng.next() * 9999 + 1), raw: "" },
          right: { type: "NumberLiteral", value: 0, raw: "0" },
        }],
        _garbage: true,
      };
    },
    // local throwaway = tostring(nil)
    function (rng) {
      const name = "_g" + rng.nextInt(0x100, 0xFFFF).toString(16);
      return {
        type: "LocalStatement",
        names: [{ type: "Identifier", name: name }],
        init:  [{
          type:      "CallExpression",
          callee:    { type: "Identifier", name: "tostring" },
          method:    null,
          kind:      "call",
          arguments: [{ type: "NilLiteral", value: null }],
        }],
        _garbage: true,
      };
    },
    // local throwaway = type("")
    function (rng) {
      const name = "_g" + rng.nextInt(0x100, 0xFFFF).toString(16);
      return {
        type: "LocalStatement",
        names: [{ type: "Identifier", name: name }],
        init:  [{
          type:      "CallExpression",
          callee:    { type: "Identifier", name: "type" },
          method:    null,
          kind:      "call",
          arguments: [{ type: "StringLiteral", value: "", raw: '""' }],
        }],
        _garbage: true,
      };
    },
  ];

  function addGarbage(ast, symbolTable, crypto, opts) {
    if (!opts.addGarbage || opts.garbageLevel < 1) return;
    const rng   = opts.rng();
    const level = Math.min(opts.garbageLevel, 3);
    const count = level * 2; // berapa statement garbage per blok

    function insertGarbage(body) {
      if (!Array.isArray(body)) return;
      const inserts = [];
      for (let i = 0; i < count; i++) {
        const tmpl = GARBAGE_TEMPLATES[rng.nextInt(0, GARBAGE_TEMPLATES.length - 1)];
        inserts.push(tmpl(rng));
      }
      // Selipkan di posisi acak
      for (let i = 0; i < inserts.length; i++) {
        const pos = rng.nextInt(0, body.length);
        body.splice(pos, 0, inserts[i]);
      }
    }

    function walk(node) {
      if (!node) return;
      if (node.type === "Block" || node.type === "Program") {
        insertGarbage(node.body);
        for (let i = 0; i < node.body.length; i++) walk(node.body[i]);
      } else if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
        if (node.body) walk(node.body);
      } else if (node.type === "WhileStatement" || node.type === "RepeatStatement" ||
                 node.type === "DoStatement" || node.type === "NumericForStatement" ||
                 node.type === "GenericForStatement") {
        if (node.body) walk(node.body);
      } else if (node.type === "IfStatement") {
        if (node.clauses) {
          for (let i = 0; i < node.clauses.length; i++) {
            if (node.clauses[i].body) walk(node.clauses[i].body);
          }
        }
        if (node.else) walk(node.else);
      }
    }

    walk(ast);
  }

  // -------------------------------------------------------
  // PASS 6 — Tambah Dead Code
  // -------------------------------------------------------

  function addDeadCode(ast, symbolTable, crypto, opts) {
    if (!opts.addDeadCode) return;
    const rng = opts.rng();

    function makeDeadIf(body) {
      // if false then <random garbage> end
      const deadBody = [];
      for (let i = 0; i < 2; i++) {
        const tmpl = GARBAGE_TEMPLATES[rng.nextInt(0, GARBAGE_TEMPLATES.length - 1)];
        deadBody.push(tmpl(rng));
      }
      return {
        type: "IfStatement",
        clauses: [{
          condition: { type: "BooleanLiteral", value: false },
          body:      { type: "Block", body: deadBody },
        }],
        else:    null,
        _dead:   true,
      };
    }

    function insertDead(body) {
      if (!Array.isArray(body) || body.length === 0) return;
      const pos = rng.nextInt(0, body.length);
      body.splice(pos, 0, makeDeadIf(body));
    }

    function walk(node) {
      if (!node) return;
      if (node.type === "Block" || node.type === "Program") {
        insertDead(node.body);
        for (let i = 0; i < node.body.length; i++) walk(node.body[i]);
      } else if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
        if (node.body) walk(node.body);
      }
    }

    walk(ast);
  }

  // -------------------------------------------------------
  // PASS 7 — Shuffle Statements (opsional, off by default)
  // -------------------------------------------------------

  function shuffleStatements(ast, symbolTable, crypto, opts) {
    if (!opts.shuffleStatements) return;
    const rng = opts.rng();

    function canShuffle(stmt) {
      // Hanya local constant yang tidak saling tergantung urutan
      return stmt.type === "LocalStatement" && !stmt.init;
    }

    function shuffleBlock(body) {
      if (!Array.isArray(body)) return;
      // Temukan run-run statement yang aman di-shuffle
      let start = -1;
      for (let i = 0; i <= body.length; i++) {
        const safe = i < body.length && canShuffle(body[i]);
        if (safe && start === -1) start = i;
        if (!safe && start !== -1) {
          const run = body.slice(start, i);
          rng.shuffle(run);
          for (let j = 0; j < run.length; j++) body[start + j] = run[j];
          start = -1;
        }
      }
      for (let i = 0; i < body.length; i++) {
        const s = body[i];
        if (s && s.body) shuffleBlock(s.body.body || s.body);
      }
    }

    shuffleBlock(ast.body);
  }

  // -------------------------------------------------------
  // Helper: walkAST dengan parent tracking
  // -------------------------------------------------------

  function walkAST(node, cb, parent, key, idx) {
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "string") {
      cb(node, parent || null, key || null, idx !== undefined ? idx : null);
    }
    for (const k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      if (k === "_sym" || k === "_obfMeta" || k === "_scope") continue;
      const v = node[k];
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          if (v[i] && typeof v[i] === "object") walkAST(v[i], cb, node, k, i);
        }
      } else if (v && typeof v === "object" && typeof v.type === "string") {
        walkAST(v, cb, node, k, undefined);
      }
    }
  }

  // -------------------------------------------------------
  // Jalankan semua pass
  // -------------------------------------------------------

  function runAll(ast, symbolTable, crypto, opts) {
    // Urutan pass penting:
    // 1. rename dulu (sebelum enkripsi, supaya nama asli sudah hilang)
    renameLocals(ast, symbolTable, crypto, opts);
    // 2. enkripsi angka (sebelum string agar string decoder tidak ikut ter-enkripsi angka)
    encryptNumbers(ast, symbolTable, crypto, opts);
    // 3. enkripsi string
    encryptStrings(ast, symbolTable, crypto, opts);
    // 4. obfuskasi kunci tabel
    obfuscateTableKeys(ast, symbolTable, crypto, opts);
    // 5. tambah dead code
    addDeadCode(ast, symbolTable, crypto, opts);
    // 6. tambah garbage
    addGarbage(ast, symbolTable, crypto, opts);
    // 7. shuffle (terakhir supaya urutan garbage juga ikut teracak)
    shuffleStatements(ast, symbolTable, crypto, opts);
  }

  // -------------------------------------------------------
  // API
  // -------------------------------------------------------

  return {
    renameLocals:        renameLocals,
    encryptStrings:      encryptStrings,
    encryptNumbers:      encryptNumbers,
    obfuscateTableKeys:  obfuscateTableKeys,
    addGarbage:          addGarbage,
    addDeadCode:         addDeadCode,
    shuffleStatements:   shuffleStatements,
    runAll:              runAll,
    walkAST:             walkAST,
  };

})();

// ---- Ekspor ----
if (typeof module !== "undefined" && module.exports) {
  module.exports = LuauOpt;
}
if (typeof globalThis !== "undefined") {
  globalThis.LuauOpt = LuauOpt;
}
