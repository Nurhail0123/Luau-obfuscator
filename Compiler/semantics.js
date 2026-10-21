// ============================================================
// semantics.js — Analisis Semantik & Scope Resolution untuk Luau Obfuscator
// JavaScript murni — berjalan di Delta Executor / Node.js / Roblox bridge
// ============================================================
// Tugas modul ini:
//   1. Resolusi scope: tentukan di mana setiap variabel didefinisikan
//   2. Tandai variabel yang boleh di-rename (bukan global Roblox)
//   3. Deteksi referensi ke variabel yang tidak pernah dideklarasikan (global)
//   4. Buat SymbolTable yang dipakai compiler & opt
// ============================================================

"use strict";

const LuauSemantics = (function () {

  // -------------------------------------------------------
  // Symbol & Scope
  // -------------------------------------------------------

  function Symbol(name, kind, node) {
    this.name        = kind; // nama ASLI
    this.originalName= name;
    this.kind        = kind; // 'local' | 'param' | 'upvalue' | 'global'
    this.node        = node; // AST node deklarasi
    this.renameTo    = null; // nama baru setelah rename (diisi compiler)
    this.refs        = [];   // semua Identifier node yang merujuk simbol ini
    this.canRename   = true; // false jika di whitelist atau global Roblox
  }

  function Scope(parent, kind) {
    this.parent   = parent || null;
    this.kind     = kind   || "block"; // 'block' | 'function' | 'global'
    this.symbols  = {};                // name -> Symbol
    this.children = [];
    if (parent) parent.children.push(this);
  }

  Scope.prototype.define = function (name, kind, node) {
    const sym = new Symbol(name, kind, node);
    sym.name = name;
    this.symbols[name] = sym;
    return sym;
  };

  Scope.prototype.lookup = function (name) {
    let scope = this;
    while (scope) {
      if (scope.symbols[name]) return scope.symbols[name];
      scope = scope.parent;
    }
    return null;
  };

  Scope.prototype.lookupLocal = function (name) {
    return this.symbols[name] || null;
  };

  // -------------------------------------------------------
  // SymbolTable — hasil analisis
  // -------------------------------------------------------

  function SymbolTable() {
    this.root     = new Scope(null, "global");
    this.globals  = {};  // nama global yang ditemukan tapi tidak dideklarasikan
    this.allScopes= [this.root];
    this.allSyms  = [];
  }

  SymbolTable.prototype.newScope = function (parent, kind) {
    const s = new Scope(parent, kind);
    this.allScopes.push(s);
    return s;
  };

  SymbolTable.prototype.define = function (scope, name, kind, node) {
    const sym = scope.define(name, kind, node);
    this.allSyms.push(sym);
    return sym;
  };

  SymbolTable.prototype.resolveOrGlobal = function (scope, name) {
    const sym = scope.lookup(name);
    if (sym) return sym;
    // Global tidak dideklarasikan
    if (!this.globals[name]) {
      const gs = new Symbol(name, "global", null);
      gs.name = name;
      gs.canRename = false;
      this.globals[name] = gs;
      this.allSyms.push(gs);
    }
    return this.globals[name];
  };

  // -------------------------------------------------------
  // Analisis AST
  // -------------------------------------------------------

  /**
   * Analisis: jalan di AST, isi SymbolTable.
   * opts: ObfuscatorOptions (untuk whitelist)
   */
  function analyze(ast, opts) {
    const table = new SymbolTable();
    const whitelist = opts && opts.globalWhitelist ? opts.globalWhitelist : [];
    const whiteSet  = {};
    for (let i = 0; i < whitelist.length; i++) whiteSet[whitelist[i]] = true;

    function markWhitelist(sym) {
      if (whiteSet[sym.name] || sym.kind === "global") {
        sym.canRename = false;
      }
    }

    // Tandai semua global yang sudah diketahui tidak bisa di-rename
    for (const n in whiteSet) {
      const s = table.define(table.root, n, "global", null);
      s.canRename = false;
    }

    function visitBlock(stmts, scope) {
      if (!stmts) return;
      for (let i = 0; i < stmts.length; i++) {
        visitStmt(stmts[i], scope);
      }
    }

    function visitStmt(node, scope) {
      if (!node) return;
      switch (node.type) {
        case "Block":
          visitBlock(node.body, scope);
          break;

        case "LocalStatement": {
          // nama di deklarasikan SETELAH ekspresi init (perilaku Luau)
          if (node.init) {
            for (let i = 0; i < node.init.length; i++) visitExpr(node.init[i], scope);
          }
          for (let i = 0; i < node.names.length; i++) {
            const nm = node.names[i];
            const name = nm.name || (nm.type === "Identifier" ? nm.name : null);
            if (name) {
              const sym = table.define(scope, name, "local", nm);
              nm._sym = sym;
              markWhitelist(sym);
            }
          }
          break;
        }

        case "AssignmentStatement": {
          for (let i = 0; i < node.targets.length; i++) visitExpr(node.targets[i], scope);
          for (let i = 0; i < node.values.length; i++) visitExpr(node.values[i], scope);
          break;
        }

        case "CallStatement":
          visitExpr(node.expression, scope);
          break;

        case "DoStatement": {
          const inner = table.newScope(scope, "block");
          node._scope = inner;
          visitBlock(node.body && node.body.body ? node.body.body : (node.body ? [node.body] : []), inner);
          break;
        }

        case "WhileStatement": {
          visitExpr(node.condition, scope);
          const ws = table.newScope(scope, "block");
          node._scope = ws;
          visitBlock(node.body && node.body.body ? node.body.body : [], ws);
          break;
        }

        case "RepeatStatement": {
          const rs = table.newScope(scope, "block");
          node._scope = rs;
          visitBlock(node.body && node.body.body ? node.body.body : [], rs);
          visitExpr(node.condition, rs); // condition sees locals of the block
          break;
        }

        case "IfStatement": {
          if (node.clauses) {
            for (let i = 0; i < node.clauses.length; i++) {
              const cl = node.clauses[i];
              if (cl.condition) visitExpr(cl.condition, scope);
              const cs = table.newScope(scope, "block");
              cl._scope = cs;
              visitBlock(cl.body && cl.body.body ? cl.body.body : [], cs);
            }
          }
          if (node.else) {
            const es = table.newScope(scope, "block");
            node.else._scope = es;
            visitBlock(node.else.body ? node.else.body : [], es);
          }
          break;
        }

        case "NumericForStatement": {
          visitExpr(node.start, scope);
          visitExpr(node.end, scope);
          if (node.step) visitExpr(node.step, scope);
          const nfs = table.newScope(scope, "block");
          node._scope = nfs;
          if (node.name) {
            const sym = table.define(nfs, node.name, "local", node);
            sym.canRename = true;
          }
          visitBlock(node.body && node.body.body ? node.body.body : [], nfs);
          break;
        }

        case "GenericForStatement": {
          for (let i = 0; i < node.iterators.length; i++) visitExpr(node.iterators[i], scope);
          const gfs = table.newScope(scope, "block");
          node._scope = gfs;
          if (node.names) {
            for (let i = 0; i < node.names.length; i++) {
              const n2 = node.names[i];
              const nm2 = typeof n2 === "string" ? n2 : n2.name;
              if (nm2) {
                const sym = table.define(gfs, nm2, "local", n2);
                if (n2._sym !== undefined) n2._sym = sym;
              }
            }
          }
          visitBlock(node.body && node.body.body ? node.body.body : [], gfs);
          break;
        }

        case "FunctionDeclaration": {
          // nama fungsi dideklarasikan di scope saat ini
          if (node.name) {
            const fnName = extractFuncName(node.name);
            if (fnName) {
              const sym = table.define(scope, fnName, "local", node.name);
              markWhitelist(sym);
              if (node.name._sym !== undefined) node.name._sym = sym;
            }
          }
          visitFuncBody(node, scope);
          break;
        }

        case "ReturnStatement":
          if (node.arguments) {
            for (let i = 0; i < node.arguments.length; i++) visitExpr(node.arguments[i], scope);
          }
          break;

        case "TypeAliasStatement":
          // type alias — tidak ada binding runtime yang perlu di-rename
          break;

        case "BreakStatement":
        case "ContinueStatement":
          break;

        default:
          // Ekspresi yang berdiri sendiri (CallStatement, dll.)
          if (node.expression) visitExpr(node.expression, scope);
          break;
      }
    }

    function visitFuncBody(node, outerScope) {
      const fs = table.newScope(outerScope, "function");
      node._scope = fs;
      if (node.parameters) {
        for (let i = 0; i < node.parameters.length; i++) {
          const p = node.parameters[i];
          const pname = typeof p === "string" ? p : (p.name || null);
          if (pname && pname !== "...") {
            const sym = table.define(fs, pname, "param", p);
            markWhitelist(sym);
            if (p && typeof p === "object") p._sym = sym;
          }
        }
      }
      visitBlock(node.body && node.body.body ? node.body.body : [], fs);
    }

    function visitExpr(node, scope) {
      if (!node) return;
      switch (node.type) {
        case "Identifier": {
          const sym = table.resolveOrGlobal(scope, node.name);
          node._sym = sym;
          sym.refs.push(node);
          break;
        }
        case "FunctionExpression":
          visitFuncBody(node, scope);
          break;
        case "CallExpression":
          visitExpr(node.callee, scope);
          if (node.arguments) {
            for (let i = 0; i < node.arguments.length; i++) visitExpr(node.arguments[i], scope);
          }
          break;
        case "MemberExpression":
          visitExpr(node.object, scope);
          // property dalam MemberExpression computed: juga dikunjungi
          if (node.computed) visitExpr(node.property, scope);
          break;
        case "IndexExpression":
          visitExpr(node.object, scope);
          visitExpr(node.index, scope);
          break;
        case "BinaryExpression":
          visitExpr(node.left, scope);
          visitExpr(node.right, scope);
          break;
        case "UnaryExpression":
          visitExpr(node.operand, scope);
          break;
        case "TableConstructorExpression":
          if (node.fields) {
            for (let i = 0; i < node.fields.length; i++) {
              const f = node.fields[i];
              if (f.key) visitExpr(f.key, scope);
              if (f.value) visitExpr(f.value, scope);
            }
          }
          break;
        case "ParenthesizedExpression":
          visitExpr(node.expression, scope);
          break;
        case "InterpStringExpression":
          if (node.parts) {
            for (let i = 0; i < node.parts.length; i++) {
              if (node.parts[i].type !== "StringLiteral") visitExpr(node.parts[i], scope);
            }
          }
          break;
        // Literal — tidak ada yang perlu diselesaikan
        default:
          break;
      }
    }

    function extractFuncName(nameNode) {
      if (!nameNode) return null;
      if (nameNode.type === "Identifier") return nameNode.name;
      if (nameNode.type === "MemberExpression") return null; // t.method — jangan rename
      return null;
    }

    // Mulai traversal dari root program
    visitBlock(ast.body ? ast.body : (ast.type === "Block" ? ast.body : [ast]), table.root);

    return table;
  }

  // -------------------------------------------------------
  // API
  // -------------------------------------------------------

  return {
    analyze:      analyze,
    Scope:        Scope,
    Symbol:       Symbol,
    SymbolTable:  SymbolTable,
  };

})();

// ---- Ekspor ----
if (typeof module !== "undefined" && module.exports) {
  module.exports = LuauSemantics;
}
if (typeof globalThis !== "undefined") {
  globalThis.LuauSemantics = LuauSemantics;
}
