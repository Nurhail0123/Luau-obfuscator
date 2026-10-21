// ============================================================
// compiler.js — Code Emitter / Compiler Utama Luau Obfuscator
// JavaScript murni — berjalan di Delta Executor / Node.js / Roblox bridge
// ============================================================
// Mengambil AST yang sudah di-obfuskasi oleh opt.js lalu
// menghasilkan kembali kode sumber Luau sebagai string.
//
// Alur lengkap:
//   source Luau
//     -> LuauAST.parse()        (AST.js / Parser.js)
//     -> LuauSemantics.analyze() (semantics.js)
//     -> LuauIRVerify.verify()  (irverify.js)
//     -> LuauOpt.runAll()       (opt.js)       -- obfuskasi
//     -> LuauCompiler.compile() (compiler.js)  -- emit Luau
//
// Penggunaan cepat:
//   const result = LuauCompiler.obfuscate(sourceString, optionsObject);
//   // result.code  -> kode Luau ter-obfuskasi
//   // result.errors -> array VerifyError (biasanya kosong)
// ============================================================

"use strict";

const LuauCompiler = (function () {

  // -------------------------------------------------------
  // Emitter — ubah AST menjadi Luau string
  // -------------------------------------------------------

  function Emitter(opts) {
    this.opts   = opts   || {};
    this.minify = opts && opts.minify !== false; // default minify
    this.out    = [];
    this._indent= 0;
  }

  Emitter.prototype.push = function (s) { this.out.push(s); };

  Emitter.prototype.nl = function () {
    if (!this.minify) this.push("\n" + "  ".repeat(this._indent));
    else this.push(" ");
  };

  Emitter.prototype.indent = function () { this._indent++; };
  Emitter.prototype.dedent = function () { this._indent = Math.max(0, this._indent - 1); };

  Emitter.prototype.result = function () { return this.out.join(""); };

  // ---- Dispatch utama ----
  Emitter.prototype.emitNode = function (node) {
    if (!node) { this.push("nil"); return; }
    switch (node.type) {
      case "Program":
      case "Block":         this.emitBlock(node); break;
      case "LocalStatement":this.emitLocal(node); break;
      case "AssignmentStatement":
      case "CompoundAssignmentStatement": this.emitAssign(node); break;
      case "CallStatement": this.emitCallStmt(node); break;
      case "DoStatement":   this.emitDo(node); break;
      case "WhileStatement":this.emitWhile(node); break;
      case "RepeatStatement":this.emitRepeat(node); break;
      case "IfStatement":   this.emitIf(node); break;
      case "NumericForStatement": this.emitNumFor(node); break;
      case "GenericForStatement": this.emitGenFor(node); break;
      case "FunctionDeclaration": this.emitFuncDecl(node); break;
      case "ReturnStatement": this.emitReturn(node); break;
      case "BreakStatement":  this.push("break"); break;
      case "ContinueStatement": this.push("continue"); break;
      case "TypeAliasStatement": /* skip — tidak ada runtime */ break;

      // Ekspresi
      case "Identifier":    this.push(node.name); break;
      case "NumberLiteral": this.emitNumber(node); break;
      case "StringLiteral": this.emitString(node); break;
      case "BooleanLiteral":this.push(node.value ? "true" : "false"); break;
      case "NilLiteral":    this.push("nil"); break;
      case "VarargLiteral": this.push("..."); break;
      case "FunctionExpression": this.emitFuncExpr(node); break;
      case "TableConstructorExpression": this.emitTable(node); break;
      case "BinaryExpression":  this.emitBinary(node); break;
      case "UnaryExpression":   this.emitUnary(node); break;
      case "MemberExpression":  this.emitMember(node); break;
      case "IndexExpression":   this.emitIndex(node); break;
      case "CallExpression":    this.emitCall(node); break;
      case "ParenthesizedExpression": this.emitParen(node); break;
      case "InterpStringExpression":  this.emitInterpStr(node); break;
      case "IfExpression":      this.emitIfExpr(node); break;

      default:
        // Tidak dikenal — coba emit raw jika ada _obfExpr
        if (node._obfExpr) { this.push(node._obfExpr); }
        else this.push("nil --[[??" + node.type + "]]");
        break;
    }
  };

  // ---- Block ----
  Emitter.prototype.emitBlock = function (node) {
    const body = node.body || [];
    for (let i = 0; i < body.length; i++) {
      this.emitNode(body[i]);
      if (i < body.length - 1) this.nl();
    }
  };

  // ---- Local ----
  Emitter.prototype.emitLocal = function (node) {
    this.push("local ");
    const names = node.names || [];
    for (let i = 0; i < names.length; i++) {
      if (i > 0) this.push(",");
      this.emitNode(names[i]);
    }
    if (node.init && node.init.length > 0) {
      this.push("=");
      for (let i = 0; i < node.init.length; i++) {
        if (i > 0) this.push(",");
        this.emitNode(node.init[i]);
      }
    }
  };

  // ---- Assignment ----
  Emitter.prototype.emitAssign = function (node) {
    const targets = node.targets || [];
    for (let i = 0; i < targets.length; i++) {
      if (i > 0) this.push(",");
      this.emitNode(targets[i]);
    }
    this.push(node.operator || "=");
    const values = node.values || [];
    for (let i = 0; i < values.length; i++) {
      if (i > 0) this.push(",");
      this.emitNode(values[i]);
    }
  };

  // ---- Call Statement ----
  Emitter.prototype.emitCallStmt = function (node) {
    this.emitNode(node.expression);
  };

  // ---- Do ----
  Emitter.prototype.emitDo = function (node) {
    this.push("do");
    this.indent(); this.nl();
    this.emitNode(node.body);
    this.dedent(); this.nl();
    this.push("end");
  };

  // ---- While ----
  Emitter.prototype.emitWhile = function (node) {
    this.push("while ");
    this.emitNode(node.condition);
    this.push(" do");
    this.indent(); this.nl();
    this.emitNode(node.body);
    this.dedent(); this.nl();
    this.push("end");
  };

  // ---- Repeat ----
  Emitter.prototype.emitRepeat = function (node) {
    this.push("repeat");
    this.indent(); this.nl();
    this.emitNode(node.body);
    this.dedent(); this.nl();
    this.push("until ");
    this.emitNode(node.condition);
  };

  // ---- If ----
  Emitter.prototype.emitIf = function (node) {
    const clauses = node.clauses || [];
    for (let i = 0; i < clauses.length; i++) {
      const cl = clauses[i];
      if (i === 0) {
        this.push("if ");
        this.emitNode(cl.condition);
        this.push(" then");
      } else if (cl.condition) {
        this.push("elseif ");
        this.emitNode(cl.condition);
        this.push(" then");
      } else {
        this.push("else");
      }
      this.indent(); this.nl();
      this.emitNode(cl.body);
      this.dedent(); this.nl();
    }
    if (node.else) {
      this.push("else");
      this.indent(); this.nl();
      this.emitNode(node.else);
      this.dedent(); this.nl();
    }
    this.push("end");
  };

  // ---- Numeric For ----
  Emitter.prototype.emitNumFor = function (node) {
    this.push("for ");
    this.push(node.name || "_i");
    this.push("=");
    this.emitNode(node.start);
    this.push(",");
    this.emitNode(node.end);
    if (node.step) { this.push(","); this.emitNode(node.step); }
    this.push(" do");
    this.indent(); this.nl();
    this.emitNode(node.body);
    this.dedent(); this.nl();
    this.push("end");
  };

  // ---- Generic For ----
  Emitter.prototype.emitGenFor = function (node) {
    this.push("for ");
    const names = node.names || [];
    for (let i = 0; i < names.length; i++) {
      if (i > 0) this.push(",");
      const n = names[i];
      this.push(typeof n === "string" ? n : (n.name || "_v"));
    }
    this.push(" in ");
    const iters = node.iterators || [];
    for (let i = 0; i < iters.length; i++) {
      if (i > 0) this.push(",");
      this.emitNode(iters[i]);
    }
    this.push(" do");
    this.indent(); this.nl();
    this.emitNode(node.body);
    this.dedent(); this.nl();
    this.push("end");
  };

  // ---- Function Declaration ----
  Emitter.prototype.emitFuncDecl = function (node) {
    this.push("local function ");
    if (node.name) this.emitNode(node.name);
    this._emitFuncParams(node);
    this.indent(); this.nl();
    this.emitNode(node.body);
    this.dedent(); this.nl();
    this.push("end");
  };

  // ---- Function Expression ----
  Emitter.prototype.emitFuncExpr = function (node) {
    this.push("function");
    this._emitFuncParams(node);
    this.indent(); this.nl();
    this.emitNode(node.body);
    this.dedent(); this.nl();
    this.push("end");
  };

  Emitter.prototype._emitFuncParams = function (node) {
    this.push("(");
    const params = node.parameters || [];
    for (let i = 0; i < params.length; i++) {
      if (i > 0) this.push(",");
      const p = params[i];
      if (typeof p === "string") this.push(p);
      else if (p && p.name) this.push(p.name);
      else if (p && p.type === "VarargLiteral") this.push("...");
      else this.push("...");
    }
    this.push(")");
  };

  // ---- Return ----
  Emitter.prototype.emitReturn = function (node) {
    this.push("return");
    const args = node.arguments || [];
    if (args.length > 0) {
      this.push(" ");
      for (let i = 0; i < args.length; i++) {
        if (i > 0) this.push(",");
        this.emitNode(args[i]);
      }
    }
  };

  // ---- Number ----
  Emitter.prototype.emitNumber = function (node) {
    if (node._obfExpr) { this.push(node._obfExpr); return; }
    this.push(node.raw || String(node.value));
  };

  // ---- String ----
  Emitter.prototype.emitString = function (node) {
    // Sudah di-enkripsi oleh opt.js -> menjadi CallExpression
    // Jika tiba di sini berarti string tidak di-enkripsi
    const v = node.value || "";
    this.push('"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"');
  };

  // ---- Table ----
  Emitter.prototype.emitTable = function (node) {
    this.push("{");
    const fields = node.fields || [];
    for (let i = 0; i < fields.length; i++) {
      if (i > 0) this.push(",");
      const f = fields[i];
      if (f.kind === "named") {
        this.emitNode(f.key);
        this.push("=");
        this.emitNode(f.value);
      } else if (f.kind === "computed") {
        this.push("[");
        this.emitNode(f.key);
        this.push("]=");
        this.emitNode(f.value);
      } else {
        this.emitNode(f.value);
      }
    }
    this.push("}");
  };

  // ---- Binary ----
  const BINARY_SPACE = { "and": true, "or": true, "not": true };
  Emitter.prototype.emitBinary = function (node) {
    const op = node.operator || "?";
    const sp  = BINARY_SPACE[op] ? " " : "";
    this.push("(");
    this.emitNode(node.left);
    this.push(sp + op + sp);
    this.emitNode(node.right);
    this.push(")");
  };

  // ---- Unary ----
  Emitter.prototype.emitUnary = function (node) {
    const op = node.operator || "-";
    this.push("(" + op);
    if (op === "not") this.push(" ");
    this.emitNode(node.operand);
    this.push(")");
  };

  // ---- Member ----
  Emitter.prototype.emitMember = function (node) {
    this.emitNode(node.object);
    if (node.computed) {
      this.push("[");
      this.emitNode(node.property);
      this.push("]");
    } else {
      this.push(".");
      this.emitNode(node.property);
    }
  };

  // ---- Index ----
  Emitter.prototype.emitIndex = function (node) {
    this.emitNode(node.object);
    this.push("[");
    this.emitNode(node.index);
    this.push("]");
  };

  // ---- Call ----
  Emitter.prototype.emitCall = function (node) {
    this.emitNode(node.callee);
    if (node.method) {
      this.push(":" + node.method);
    }
    this.push("(");
    const args = node.arguments || [];
    for (let i = 0; i < args.length; i++) {
      if (i > 0) this.push(",");
      this.emitNode(args[i]);
    }
    this.push(")");
  };

  // ---- Parenthesized ----
  Emitter.prototype.emitParen = function (node) {
    this.push("(");
    this.emitNode(node.expression);
    this.push(")");
  };

  // ---- Interpolated String ----
  Emitter.prototype.emitInterpStr = function (node) {
    this.push("`");
    const parts = node.parts || [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.type === "InterpText" || p.type === "StringLiteral") {
        this.push(p.value || "");
      } else {
        this.push("{");
        this.emitNode(p);
        this.push("}");
      }
    }
    this.push("`");
  };

  // ---- If Expression (Luau) ----
  Emitter.prototype.emitIfExpr = function (node) {
    const clauses = node.clauses || [];
    for (let i = 0; i < clauses.length; i++) {
      const cl = clauses[i];
      if (i === 0) {
        this.push("if ");
        this.emitNode(cl.condition);
        this.push(" then ");
        this.emitNode(cl.value || cl.body);
      } else {
        this.push(" elseif ");
        this.emitNode(cl.condition);
        this.push(" then ");
        this.emitNode(cl.value || cl.body);
      }
    }
    if (node.else) {
      this.push(" else ");
      this.emitNode(node.else);
    }
  };

  // -------------------------------------------------------
  // emit() — titik masuk emitter
  // -------------------------------------------------------

  function emit(ast, opts) {
    const em = new Emitter(opts);

    // Emit decoder string jika ada
    if (ast._obfMeta && ast._obfMeta.strDecoder) {
      const d = ast._obfMeta.strDecoder;
      // Gunakan fungsi dari LuauCrypto jika tersedia
      let decoderCode;
      if (typeof LuauCrypto !== "undefined") {
        decoderCode = LuauCrypto.emitLuauDecoder(d.decoderName, d.keyVarName, d.keyTable);
      } else {
        // fallback inline
        decoderCode = (
          "local " + d.keyVarName + "=" + d.keyTable + "\n" +
          "local function " + d.decoderName + "(t)\n" +
          "local r=\"\"\n" +
          "local k=" + d.keyVarName + "\n" +
          "for i=1,#t do r=r..string.char(bit32.bxor(t[i],k[((i-1)%#k)+1]))end\n" +
          "return r end\n"
        );
      }
      em.push(decoderCode);
      if (!opts || opts.minify !== false) em.push(" ");
      else em.push("\n");
    }

    em.emitNode(ast);
    return em.result();
  }

  // -------------------------------------------------------
  // obfuscate() — API all-in-one
  // -------------------------------------------------------

  /**
   * Obfuskasi kode sumber Luau.
   *
   * @param {string} source          - kode Luau asli
   * @param {object|ObfuscatorOptions} optsOrObj - opsi (lihat options.js)
   * @returns {{ code: string, errors: array, ast: object }}
   */
  function obfuscate(source, optsOrObj) {
    // Deteksi modul yang tersedia
    const hasParse    = typeof LuauAST    !== "undefined" && LuauAST.parse;
    const hasSemantics= typeof LuauSemantics !== "undefined" && LuauSemantics.analyze;
    const hasVerify   = typeof LuauIRVerify !== "undefined" && LuauIRVerify.verify;
    const hasOpt      = typeof LuauOpt    !== "undefined" && LuauOpt.runAll;
    const hasCrypto   = typeof LuauCrypto !== "undefined";

    if (!hasParse) throw new Error("[LuauCompiler] LuauAST tidak dimuat. Load AST.js / Parser.js lebih dulu.");

    // Normalisasi opsi
    let opts;
    if (typeof ObfuscatorOptions !== "undefined") {
      opts = (optsOrObj instanceof ObfuscatorOptions) ? optsOrObj : new ObfuscatorOptions(optsOrObj);
    } else {
      // Fallback minimal
      opts = Object.assign({
        renameVariables: true, renameGlobals: false, renamePrefix: "_0x",
        encryptStrings: true, encryptNumbers: true, obfuscateTableKeys: true,
        addDeadCode: true, addGarbage: true, garbageLevel: 1, shuffleStatements: false,
        minify: true, removeComments: true,
        globalWhitelist: ["game","workspace","script","require","print","warn","error",
          "tostring","tonumber","type","pcall","xpcall","ipairs","pairs","next","select",
          "unpack","table","string","math","bit32","utf8","os","task","coroutine"],
        _seed: Math.random() * 0xFFFFFFFF | 0,
        rng: function () {
          let s = this._seed || 1;
          return {
            next: function () { s ^= s<<13; s ^= s>>>17; s ^= s<<5; s = s>>>0; return s/0x100000000; },
            nextInt: function (a,b) { return a+Math.floor(this.next()*(b-a+1)); },
            shuffle: function (arr) { for(let i=arr.length-1;i>0;i--){const j=this.nextInt(0,i);const t=arr[i];arr[i]=arr[j];arr[j]=t;} return arr; },
            nextId: function (p,l) { p=p||"_0x";l=l||8;let r=p;const H="0123456789abcdef";for(let i=0;i<l;i++)r+=H[Math.floor(this.next()*16)];return r; }
          };
        },
        isWhitelisted: function (n) { return this.globalWhitelist.indexOf(n) !== -1; }
      }, optsOrObj || {});
    }

    // 1. Parse
    const ast = LuauAST.parse(source);

    // 2. Analisis semantik
    let symbolTable = { allSyms: [], globals: {} };
    if (hasSemantics) {
      symbolTable = LuauSemantics.analyze(ast, opts);
    }

    // 3. Verifikasi IR
    let verifyErrors = [];
    if (hasVerify) {
      const vr = LuauIRVerify.verify(ast);
      verifyErrors = vr.errors;
      if (!vr.ok && opts.verbose) {
        for (let i = 0; i < vr.errors.length; i++) console.warn(vr.errors[i].toString());
      }
    }

    // 4. Optimisasi / obfuskasi
    const cryptoMod = hasCrypto ? LuauCrypto : _minimalCrypto();
    if (hasOpt) {
      LuauOpt.runAll(ast, symbolTable, cryptoMod, opts);
    }

    // 5. Emit kode
    const code = emit(ast, opts);

    return {
      code:   code,
      errors: verifyErrors,
      ast:    ast,
    };
  }

  // Crypto fallback minimal (jika crypto.js tidak dimuat)
  function _minimalCrypto() {
    return {
      generateKey: function (len, rng) { const k=[]; for(let i=0;i<len;i++) k.push(1+Math.floor(rng.next()*254)); return k; },
      encryptString: function (s, k) { const b=[]; for(let i=0;i<s.length;i++) b.push(s.charCodeAt(i)^k[i%k.length]); return b; },
      keyToLuaTable: function (k) { return "{"+k.join(",")+"}"; },
      emitLuauDecoder: function (dn, kv, kt) { return "local "+kv+"="+kt+"\nlocal function "+dn+"(t)local r=\"\"local k="+kv+" for i=1,#t do r=r..string.char(bit32.bxor(t[i],k[((i-1)%#k)+1]))end return r end\n"; },
      emitDecodeCall: function (dn, bytes) { return dn+"({"+bytes.join(",")+"})"; },
      obfuscateNumber: function (n, rng) { const o=rng.nextInt(1,9999); return "(("+(n+o)+")-"+o+")"; },
      hashStr: function (s) { let h=5381; for(let i=0;i<s.length;i++) h=((h<<5)+h)^s.charCodeAt(i); return h>>>0; },
      makeObfName: function (orig, seed, prefix) { return (prefix||"_0x")+(((this.hashStr(orig)^(seed>>>0))>>>0).toString(16).padStart(8,"0")); },
    };
  }

  // -------------------------------------------------------
  // API
  // -------------------------------------------------------

  return {
    obfuscate: obfuscate,
    emit:      emit,
    Emitter:   Emitter,
  };

})();

// ---- Ekspor ----
if (typeof module !== "undefined" && module.exports) {
  module.exports = LuauCompiler;
}
if (typeof globalThis !== "undefined") {
  globalThis.LuauCompiler = LuauCompiler;
}
