// ============================================================
// irverify.js — Verifikasi IR (Intermediate Representation) Luau Obfuscator
// JavaScript murni — berjalan di Delta Executor / Node.js / Roblox bridge
// ============================================================
// Tugas modul ini:
//   1. Validasi AST/IR sebelum dikirim ke pass emisi kode
//   2. Deteksi node tidak valid / inkonsisten
//   3. Deteksi infinite recursion / cycle di dalam AST
//   4. Beri laporan error yang jelas (baris, kolom, jenis node)
// ============================================================

"use strict";

const LuauIRVerify = (function () {

  // -------------------------------------------------------
  // Daftar node type yang valid
  // -------------------------------------------------------

  const VALID_STMT_TYPES = new Set([
    "Block",
    "LocalStatement",
    "AssignmentStatement",
    "CompoundAssignmentStatement",
    "CallStatement",
    "DoStatement",
    "WhileStatement",
    "RepeatStatement",
    "IfStatement",
    "NumericForStatement",
    "GenericForStatement",
    "FunctionDeclaration",
    "ReturnStatement",
    "BreakStatement",
    "ContinueStatement",
    "TypeAliasStatement",
  ]);

  const VALID_EXPR_TYPES = new Set([
    "Identifier",
    "NumberLiteral",
    "StringLiteral",
    "BooleanLiteral",
    "NilLiteral",
    "VarargLiteral",
    "FunctionExpression",
    "TableConstructorExpression",
    "BinaryExpression",
    "UnaryExpression",
    "MemberExpression",
    "IndexExpression",
    "CallExpression",
    "ParenthesizedExpression",
    "InterpStringExpression",
    "IfExpression",
  ]);

  const VALID_TYPE_TYPES = new Set([
    "NameType", "GenericType", "UnionType", "IntersectionType",
    "OptionalType", "ArrayType", "FunctionType", "TableType",
    "TypeofType", "LiteralType", "NilType", "VariadicTypePack",
  ]);

  // -------------------------------------------------------
  // Verifikasi
  // -------------------------------------------------------

  function VerifyError(message, node) {
    this.message = message;
    this.node    = node || null;
    this.line    = node ? (node.line || 0) : 0;
    this.col     = node ? (node.column || 0) : 0;
  }
  VerifyError.prototype.toString = function () {
    return "[IRVerify] " + this.message +
      (this.line ? " (baris " + this.line + ", kolom " + this.col + ")" : "");
  };

  /**
   * Verifikasi AST/IR.
   * @param {object} root - node root (Program / Block)
   * @returns {{ ok: boolean, errors: VerifyError[] }}
   */
  function verify(root) {
    const errors = [];
    const visited = new Set();

    function err(msg, node) {
      errors.push(new VerifyError(msg, node));
    }

    function checkNode(node, context) {
      if (node === null || node === undefined) return;
      if (typeof node !== "object") return;

      // Cek cycle
      if (visited.has(node)) {
        err("Cycle terdeteksi di AST (node yang sama muncul dua kali)", node);
        return;
      }
      visited.add(node);

      if (!node.type) {
        // Objek bukan node (mis. field pembungkus) — lanjut lewat nilai-nilainya
        for (const k in node) {
          const v = node[k];
          if (v && typeof v === "object") checkNode(v, context);
        }
        visited.delete(node);
        return;
      }

      // Validasi tipe node berdasarkan konteks
      if (context === "stmt") {
        if (!VALID_STMT_TYPES.has(node.type) && !VALID_EXPR_TYPES.has(node.type)) {
          err("Tipe node tidak valid sebagai statement: '" + node.type + "'", node);
        }
      } else if (context === "expr") {
        if (!VALID_EXPR_TYPES.has(node.type)) {
          // Beberapa tipe khusus yang diizinkan dalam ekspresi konteks
          if (!VALID_TYPE_TYPES.has(node.type)) {
            err("Tipe node tidak valid sebagai ekspresi: '" + node.type + "'", node);
          }
        }
      }

      // Validasi per node type
      switch (node.type) {
        case "Program":
        case "Block":
          if (!Array.isArray(node.body)) {
            err("Block.body harus berupa array", node);
          } else {
            for (let i = 0; i < node.body.length; i++) checkNode(node.body[i], "stmt");
          }
          break;

        case "LocalStatement":
          if (!Array.isArray(node.names) || node.names.length === 0) {
            err("LocalStatement.names harus array yang tidak kosong", node);
          }
          if (node.init && !Array.isArray(node.init)) {
            err("LocalStatement.init harus array jika ada", node);
          }
          if (node.names) {
            for (let i = 0; i < node.names.length; i++) {
              const n = node.names[i];
              if (!n) continue;
              if (n.type !== "Identifier") err("LocalStatement.names[" + i + "] harus Identifier", node);
            }
          }
          if (node.init) {
            for (let i = 0; i < node.init.length; i++) checkNode(node.init[i], "expr");
          }
          break;

        case "AssignmentStatement":
        case "CompoundAssignmentStatement":
          if (!Array.isArray(node.targets) || node.targets.length === 0) {
            err(node.type + ".targets harus array tidak kosong", node);
          } else {
            for (let i = 0; i < node.targets.length; i++) {
              const t = node.targets[i];
              if (!t) continue;
              if (t.type !== "Identifier" && t.type !== "MemberExpression" && t.type !== "IndexExpression") {
                err("Target assignment tidak valid: '" + t.type + "'", t);
              }
            }
          }
          if (!Array.isArray(node.values)) {
            err(node.type + ".values harus array", node);
          } else {
            for (let i = 0; i < node.values.length; i++) checkNode(node.values[i], "expr");
          }
          break;

        case "CallStatement":
          if (!node.expression) {
            err("CallStatement.expression tidak boleh null", node);
          } else {
            if (node.expression.type !== "CallExpression") {
              err("CallStatement.expression harus CallExpression, bukan '" + node.expression.type + "'", node);
            }
            checkNode(node.expression, "expr");
          }
          break;

        case "IfStatement":
          if (!Array.isArray(node.clauses) || node.clauses.length === 0) {
            err("IfStatement.clauses harus array tidak kosong", node);
          } else {
            for (let i = 0; i < node.clauses.length; i++) {
              const cl = node.clauses[i];
              if (i === 0 && !cl.condition) err("Klausa if pertama harus punya condition", node);
              if (cl.condition) checkNode(cl.condition, "expr");
              if (cl.body) checkNode(cl.body, "stmt");
            }
          }
          if (node.else) checkNode(node.else, "stmt");
          break;

        case "WhileStatement":
          if (!node.condition) err("WhileStatement.condition tidak boleh null", node);
          else checkNode(node.condition, "expr");
          if (!node.body) err("WhileStatement.body tidak boleh null", node);
          else checkNode(node.body, "stmt");
          break;

        case "RepeatStatement":
          if (!node.body) err("RepeatStatement.body tidak boleh null", node);
          else checkNode(node.body, "stmt");
          if (!node.condition) err("RepeatStatement.condition tidak boleh null", node);
          else checkNode(node.condition, "expr");
          break;

        case "NumericForStatement":
          if (!node.start || !node.end) err("NumericForStatement butuh start & end", node);
          if (node.start) checkNode(node.start, "expr");
          if (node.end)   checkNode(node.end, "expr");
          if (node.step)  checkNode(node.step, "expr");
          if (!node.body) err("NumericForStatement.body tidak boleh null", node);
          else checkNode(node.body, "stmt");
          break;

        case "GenericForStatement":
          if (!Array.isArray(node.iterators) || node.iterators.length === 0) {
            err("GenericForStatement.iterators harus array tidak kosong", node);
          } else {
            for (let i = 0; i < node.iterators.length; i++) checkNode(node.iterators[i], "expr");
          }
          if (!node.body) err("GenericForStatement.body tidak boleh null", node);
          else checkNode(node.body, "stmt");
          break;

        case "FunctionDeclaration":
        case "FunctionExpression":
          if (!node.body) err(node.type + ".body tidak boleh null", node);
          else checkNode(node.body, "stmt");
          if (node.parameters && !Array.isArray(node.parameters)) {
            err(node.type + ".parameters harus array", node);
          }
          break;

        case "ReturnStatement":
          if (node.arguments) {
            if (!Array.isArray(node.arguments)) err("ReturnStatement.arguments harus array", node);
            else {
              for (let i = 0; i < node.arguments.length; i++) checkNode(node.arguments[i], "expr");
            }
          }
          break;

        case "Identifier":
          if (typeof node.name !== "string" || node.name.length === 0) {
            err("Identifier.name harus string tidak kosong", node);
          }
          break;

        case "NumberLiteral":
          if (typeof node.value !== "number") err("NumberLiteral.value harus number", node);
          break;

        case "StringLiteral":
          if (typeof node.value !== "string") err("StringLiteral.value harus string", node);
          break;

        case "BooleanLiteral":
          if (typeof node.value !== "boolean") err("BooleanLiteral.value harus boolean", node);
          break;

        case "BinaryExpression":
          if (!node.left)     err("BinaryExpression.left tidak boleh null", node);
          if (!node.right)    err("BinaryExpression.right tidak boleh null", node);
          if (!node.operator) err("BinaryExpression.operator tidak boleh null", node);
          if (node.left)  checkNode(node.left, "expr");
          if (node.right) checkNode(node.right, "expr");
          break;

        case "UnaryExpression":
          if (!node.operand)  err("UnaryExpression.operand tidak boleh null", node);
          if (!node.operator) err("UnaryExpression.operator tidak boleh null", node);
          if (node.operand) checkNode(node.operand, "expr");
          break;

        case "MemberExpression":
          if (!node.object)   err("MemberExpression.object tidak boleh null", node);
          if (!node.property) err("MemberExpression.property tidak boleh null", node);
          if (node.object) checkNode(node.object, "expr");
          break;

        case "IndexExpression":
          if (!node.object) err("IndexExpression.object tidak boleh null", node);
          if (!node.index)  err("IndexExpression.index tidak boleh null", node);
          if (node.object) checkNode(node.object, "expr");
          if (node.index)  checkNode(node.index, "expr");
          break;

        case "CallExpression":
          if (!node.callee) err("CallExpression.callee tidak boleh null", node);
          else checkNode(node.callee, "expr");
          if (node.arguments) {
            for (let i = 0; i < node.arguments.length; i++) checkNode(node.arguments[i], "expr");
          }
          break;

        case "TableConstructorExpression":
          if (node.fields) {
            for (let i = 0; i < node.fields.length; i++) {
              const f = node.fields[i];
              if (!f) continue;
              if (f.key)   checkNode(f.key, "expr");
              if (f.value) checkNode(f.value, "expr");
              if (!f.value) err("TableField.value tidak boleh null", node);
            }
          }
          break;

        default:
          // Node type yang tidak dikenal — biarkan lewat (parser baru bisa tambah tipe baru)
          break;
      }

      visited.delete(node);
    }

    checkNode(root, "stmt");

    return {
      ok:     errors.length === 0,
      errors: errors,
    };
  }

  /**
   * Verifikasi dan lempar error jika ada masalah.
   */
  function verifyOrThrow(root) {
    const result = verify(root);
    if (!result.ok) {
      const msgs = result.errors.map(function (e) { return e.toString(); }).join("\n");
      throw new Error("[LuauIRVerify] AST tidak valid:\n" + msgs);
    }
  }

  // -------------------------------------------------------
  // API
  // -------------------------------------------------------

  return {
    verify:        verify,
    verifyOrThrow: verifyOrThrow,
    VerifyError:   VerifyError,
  };

})();

// ---- Ekspor ----
if (typeof module !== "undefined" && module.exports) {
  module.exports = LuauIRVerify;
}
if (typeof globalThis !== "undefined") {
  globalThis.LuauIRVerify = LuauIRVerify;
}
