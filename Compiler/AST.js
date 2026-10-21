/* ============================================================================
 * LuauAST v1.0.0 — Parser Luau lengkap + AST dalam JavaScript murni (ES2020)
 * Target runtime: bridge JavaScript Delta Executor di dalam Roblox (Luau).
 *
 * Modul ini adalah komponen FRONTEND untuk obfuscator Luau:
 *   sumber Luau  --(tokenize)-->  token  --(parse)-->  AST  --(walk)-->  pass obfuscasi
 *
 * Pemakaian dari JS:
 *   const ast    = LuauAST.parse(source);        // -> Program node
 *   const tokens = LuauAST.tokenize(source);     // -> array token
 *   LuauAST.walk(ast, (node) => { ... });        // traversal AST
 *
 * Pemakaian dari Luau (Delta Executor) — pola umum:
 *   -- simpan isi file ini sebagai string JS, eval sekali lewat bridge JS Delta,
 *   -- lalu: local hasil = js([[ return JSON.stringify(LuauAST.parse(SRC)) ]])
 *   --      local ast  = game:GetService("HttpService"):JSONDecode(hasil)
 *   (Nama bridge JS Delta bervariasi antar versi: jsc / js / runJS — cek versi kamu.)
 * ==========================================================================*/
"use strict";

const LuauAST = (function () {

  /* ============================== KONSTANTA ============================== */

  const VERSION = "1.0.0";

  const KEYWORDS = new Set([
    "and", "break", "continue", "do", "else", "elseif", "end", "false",
    "for", "function", "if", "in", "local", "nil", "not", "or", "repeat",
    "return", "then", "true", "until", "while", "type", "export",
  ]);

  const ASSIGN_OPS = new Set([
    "=", "+=", "-=", "*=", "/=", "//=", "%=", "^=", "..=", "<<=", ">>=", "&=", "|=",
  ]);

  const UNARY_OPS = new Set(["not", "-", "#", "~"]);

  // [prioritas kiri, prioritas kanan] — lebih tinggi = lebih mengikat
  const BINARY_PRIORITY = {
    "or":  [1, 1],
    "and": [2, 2],
    "<":   [3, 3], ">": [3, 3], "<=": [3, 3], ">=": [3, 3], "~=": [3, 3], "==": [3, 3],
    "..":  [5, 4],                                    // kanan-asosiatif
    "+":   [6, 6], "-": [6, 6],
    "*":   [7, 7], "/": [7, 7], "//": [7, 7], "%": [7, 7],
    "&":   [8, 8], "|": [8, 8], "~": [8, 8], "<<": [8, 8], ">>": [8, 8],
    "^":   [10, 9],                                   // kanan-asosiatif, lebih kuat dari unary
  };
  const UNARY_PRIORITY = 8;

  const MULTI_OPS = [
    "...", "..=", "//=", "<<=", ">>=",
    "==", "~=", "<=", ">=", "<<", ">>", "..", "->",
    "+=", "-=", "*=", "/=", "%=", "^=", "&=", "|=", "//",
  ];
  const SINGLE_OPS = "+-*/%^#&~|<>=.:,;(){}[]?";

  class LuauSyntaxError extends Error {
    constructor(message, line, column) {
      super("[LuauAST] " + message + " (baris " + line + ", kolom " + column + ")");
      this.name = "LuauSyntaxError";
      this.line = line;
      this.column = column;
    }
  }

  /* ============================== UTILITAS =============================== */

  function isDigit(c) { return c >= "0" && c <= "9"; }
  function isHex(c)   { return isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F"); }
  function isAlpha(c) { return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_"; }
  function isAlnum(c) { return isAlpha(c) || isDigit(c); }

  function parseNumberValue(raw) {
    try {
      if (/^0[xX]/.test(raw)) {
        const m = raw.match(/^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?[0-9]+))?$/);
        if (!m) return NaN;
        let val = parseInt(m[1] || "0", 16);
        if (m[2]) val += parseInt(m[2], 16) / Math.pow(16, m[2].length);
        if (m[3]) val *= Math.pow(2, parseInt(m[3], 10));
        return val;
      }
      if (/^0[bB]/.test(raw)) return parseInt(raw.slice(2), 2);
      return parseFloat(raw);
    } catch (e) { return NaN; }
  }

  /* ============================== TOKENIZER ============================== */

  function tokenize(src) {
    if (typeof src !== "string") throw new TypeError("sumber harus berupa string");
    const tokens = [];
    let i = 0, line = 1, col = 1;
    const n = src.length;

    function error(msg) { throw new LuauSyntaxError(msg, line, col); }
    function advance(k) {
      for (let m = 0; m < k; m++) {
        if (src[i] === "\n") { line++; col = 1; } else { col++; }
        i++;
      }
    }
    function push(type, value, sl, sc, s) {
      tokens.push({ type: type, value: value, line: sl, column: sc, range: [s, i] });
    }

    // Baca bracket panjang [=[ ... ]=]. Asumsikan src[i] === '['.
    // Mengembalikan { content } dan memajukan posisi, atau null bila bukan long bracket.
    function tryReadLongBracket() {
      if (src[i] !== "[") return null;
      let j = i + 1, eq = 0;
      while (j < n && src[j] === "=") { eq++; j++; }
      if (j >= n || src[j] !== "[") return null;
      j++;
      if (src[j] === "\r" && src[j + 1] === "\n") j += 2;
      else if (src[j] === "\n" || src[j] === "\r") j++;
      const close = "]" + "=".repeat(eq) + "]";
      const endIdx = src.indexOf(close, j);
      if (endIdx === -1) error("bracket panjang tidak ditutup");
      const content = src.slice(j, endIdx);
      while (i < endIdx + close.length) advance(1);
      return { content: content };
    }

    function readEscape() {
      // Asumsikan src[i] === '\\'
      const e = src[i + 1];
      if (e === undefined) error("escape string tidak lengkap");
      switch (e) {
        case "a": case "b": case "f": case "n": case "r": case "t": case "v":
        case "\\": case "\"": case "'":
          advance(2);
          return { value: { a: "\x07", b: "\x08", f: "\x0c", n: "\n", r: "\r", t: "\t", v: "\x0b" }[e] || e };
        case "\n": advance(2); return { value: "" };     // kelanjutan baris
        case "\r": advance(2); if (src[i] === "\n") advance(1); return { value: "" };
        case "x": {
          advance(2);
          const h = src.slice(i, i + 2);
          if (h.length < 2 || !isHex(h[0]) || !isHex(h[1])) error("\\x membutuhkan 2 digit heksadesimal");
          advance(2);
          return { value: String.fromCharCode(parseInt(h, 16)) };
        }
        case "u": {
          advance(2);
          if (src[i] !== "{") error("\\u membutuhkan '{'");
          advance(1);
          let h = "";
          while (i < n && src[i] !== "}") { h += src[i]; advance(1); }
          if (src[i] !== "}") error("\\u tidak ditutup oleh '}'");
          advance(1);
          if (!h || !Array.from(h).every(isHex)) error("digit \\u tidak valid");
          return { value: String.fromCodePoint(parseInt(h, 16)) };
        }
        case "z": {
          advance(2);
          while (i < n && " \t\r\n\x0c\x0b".indexOf(src[i]) !== -1) advance(1);
          return { value: "" };
        }
        default:
          if (isDigit(e)) {
            let d = "";
            while (d.length < 3 && i + 1 < n && isDigit(src[i + 1])) { d += src[i + 1]; advance(1); }
            advance(1);
            const code = parseInt(d, 10);
            if (code > 255) error("escape desimal > 255");
            return { value: String.fromCharCode(code) };
          }
          advance(2); // escape tak dikenal -> karakter itu sendiri (perilaku Lua)
          return { value: e };
      }
    }

    function readQuotedString(quote) {
      const s = i, sl = line, sc = col;
      advance(1);
      let value = "";
      while (i < n) {
        const c = src[i];
        if (c === quote) { advance(1); push("string", { value: value, raw: src.slice(s, i), interpolated: false }, sl, sc, s); return; }
        if (c === "\n" || c === "\r") error("string tidak ditutup");
        if (c === "\\") { value += readEscape().value; continue; }
        value += c; advance(1);
      }
      error("string tidak ditutup");
    }

    function readInterpString() {
      const s = i, sl = line, sc = col;
      advance(1); // `
      const parts = [];
      let text = "";
      let closed = false;

      function skipQuoted(quote) {
        advance(1);
        while (i < n) {
          const c = src[i];
          if (c === "\n" || c === "\r") error("string di dalam interpolasi tidak ditutup");
          if (c === "\\") { advance(2); continue; }
          if (c === quote) { advance(1); return; }
          advance(1);
        }
        error("string tidak ditutup");
      }

      while (i < n) {
        const c = src[i];
        if (c === "`") { advance(1); closed = true; break; }
        if (c === "\n" || c === "\r") error("string interpolasi tidak ditutup");
        if (c === "\\") { text += readEscape().value; continue; }
        if (c !== "{") { text += c; advance(1); continue; }

        // ---- ekspresi interpolasi { ... } dengan penghitungan kedalaman ----
        if (text !== "") { parts.push({ type: "text", value: text }); text = ""; }
        advance(1);
        const start = i;
        let depth = 1;
        while (i < n && depth > 0) {
          const ch = src[i];
          if (ch === '"' || ch === "'") { skipQuoted(ch); continue; }
          if (ch === "`") { // interpolasi bersarang: lewati sampai backtick penutup
            advance(1);
            while (i < n && src[i] !== "`") { if (src[i] === "\\") advance(1); advance(1); }
            if (src[i] === "`") advance(1); else error("string interpolasi bersarang tidak ditutup");
            continue;
          }
          if (ch === "[") { // kemungkinan long string
            let j = i + 1, eq = 0;
            while (j < n && src[j] === "=") { eq++; j++; }
            if (j < n && src[j] === "[") {
              const close = "]" + "=".repeat(eq) + "]";
              const endIdx = src.indexOf(close, j + 1);
              if (endIdx === -1) error("long string tidak ditutup");
              while (i < endIdx + close.length) advance(1);
              continue;
            }
          }
          if (ch === "-" && src[i + 1] === "-") { // komentar
            advance(2);
            if (src[i] === "[") {
              let j = i + 1, eq = 0;
              while (j < n && src[j] === "=") { eq++; j++; }
              if (j < n && src[j] === "[") {
                const close = "]" + "=".repeat(eq) + "]";
                const endIdx = src.indexOf(close, j + 1);
                if (endIdx === -1) error("komentar panjang tidak ditutup");
                while (i < endIdx + close.length) advance(1);
                continue;
              }
            }
            while (i < n && src[i] !== "\n") advance(1);
            continue;
          }
          if (ch === "{") depth++;
          else if (ch === "}") { depth--; if (depth === 0) break; }
          advance(1);
        }
        if (depth !== 0) error("interpolasi tidak ditutup oleh '}'");
        const innerSrc = src.slice(start, i);
        advance(1); // tutup }
        parts.push({ type: "expr", source: innerSrc, tokens: tokenize(innerSrc) });
      }
      if (!closed) error("string interpolasi tidak ditutup");
      if (text !== "") parts.push({ type: "text", value: text });
      push("string", { value: null, raw: src.slice(s, i), interpolated: true, parts: parts }, sl, sc, s);
    }

    function readNumber() {
      const s = i, sl = line, sc = col;
      let j = i;
      if (src[j] === "0" && (src[j + 1] === "x" || src[j + 1] === "X")) {
        j += 2;
        if (!isHex(src[j])) error("angka heksadesimal tidak valid");
        while (j < n && isHex(src[j])) j++;
        if (src[j] === "." && isHex(src[j + 1])) { j++; while (j < n && isHex(src[j])) j++; }
        if (src[j] === "p" || src[j] === "P") {
          j++; if (src[j] === "+" || src[j] === "-") j++;
          if (!isDigit(src[j])) error("eksponen heksadesimal tidak valid");
          while (j < n && isDigit(src[j])) j++;
        }
      } else if (src[j] === "0" && (src[j + 1] === "b" || src[j + 1] === "B")) {
        j += 2;
        if (src[j] !== "0" && src[j] !== "1") error("angka binari tidak valid");
        while (j < n && (src[j] === "0" || src[j] === "1")) j++;
      } else {
        while (j < n && isDigit(src[j])) j++;
        if (src[j] === "." && isDigit(src[j + 1])) { j++; while (j < n && isDigit(src[j])) j++; }
        else if (src[j] === "." && src[j + 1] !== ".") j++; // "1." legal
        if (src[j] === "e" || src[j] === "E") {
          let k = j + 1;
          if (src[k] === "+" || src[k] === "-") k++;
          if (isDigit(src[k])) { j = k; while (j < n && isDigit(src[j])) j++; }
        }
      }
      const raw = src.slice(s, j);
      while (i < j) advance(1);
      push("number", raw, sl, sc, s);
    }

    /* ------------------------------ loop utama --------------------------- */
    while (i < n) {
      const c = src[i];

      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\x0c" || c === "\x0b") { advance(1); continue; }

      // komentar
      if (c === "-" && src[i + 1] === "-") {
        const s = i, sl = line, sc = col;
        advance(2);
        const lb = tryReadLongBracket();
        if (lb) { push("comment", lb.content, sl, sc, s); continue; }
        while (i < n && src[i] !== "\n") advance(1);
        push("comment", src.slice(s, i), sl, sc, s);
        continue;
      }

      const s = i, sl = line, sc = col;

      // long string
      if (c === "[") {
        const lb = tryReadLongBracket();
        if (lb) { push("string", { value: lb.content, raw: src.slice(s, i), interpolated: false }, sl, sc, s); continue; }
      }

      if (isDigit(c) || (c === "." && isDigit(src[i + 1]))) { readNumber(); continue; }

      if (isAlpha(c)) {
        let j = i;
        while (j < n && isAlnum(src[j])) j++;
        const word = src.slice(i, j);
        advance(j - i);
        push(KEYWORDS.has(word) ? "keyword" : "ident", word, sl, sc, s);
        continue;
      }

      if (c === "\"" || c === "'") { readQuotedString(c); continue; }
      if (c === "`") { readInterpString(); continue; }

      let matched = null;
      for (let k = 0; k < MULTI_OPS.length; k++) {
        if (src.startsWith(MULTI_OPS[k], i)) { matched = MULTI_OPS[k]; break; }
      }
      if (matched) { advance(matched.length); push("op", matched, sl, sc, s); continue; }
      if (SINGLE_OPS.indexOf(c) !== -1) { advance(1); push("op", c, sl, sc, s); continue; }

      error("karakter tak dikenal " + JSON.stringify(c));
    }

    tokens.push({ type: "eof", value: "<eof>", line: line, column: col, range: [n, n] });
    return tokens;
  }

  /* ================================ PARSER =============================== */

  function Parser(allTokens) {
    this.comments = allTokens.filter(function (t) { return t.type === "comment"; });
    this.tokens = allTokens.filter(function (t) { return t.type !== "comment"; });
    this.pos = 0;
  }

  Parser.prototype.peek = function (k) {
    return this.tokens[Math.min(this.pos + (k || 0), this.tokens.length - 1)];
  };
  Parser.prototype.cur = function () { return this.peek(0); };
  Parser.prototype.prev = function () { return this.tokens[this.pos - 1]; };
  Parser.prototype.next = function () {
    const t = this.cur();
    if (t.type !== "eof") this.pos++;
    return t;
  };
  Parser.prototype.is = function (type, value) {
    const t = this.cur();
    return t.type === type && (value === undefined || t.value === value);
  };
  Parser.prototype.isOp = function (v) { return this.is("op", v); };
  Parser.prototype.isKw = function (v) { return this.is("keyword", v); };
  Parser.prototype.expect = function (type, value, what) {
    if (!this.is(type, value)) {
      const t = this.cur();
      throw new LuauSyntaxError(
        "diharapkan " + (what || (value !== undefined ? JSON.stringify(value) : type)) +
        ", dapat " + JSON.stringify(t.value), t.line, t.column);
    }
    return this.next();
  };
  Parser.prototype.node = function (type, props, startTok, endTok) {
    return Object.assign(
      { type: type, line: startTok.line, column: startTok.column, range: [startTok.range[0], (endTok || startTok).range[1]] },
      props
    );
  };
  Parser.prototype.mkSpan = function (type, props, startN, endN) {
    return Object.assign(
      { type: type, line: startN.line, column: startN.column, range: [startN.range[0], endN.range[1]] },
      props
    );
  };

  /* ------------------------------ program/blok ------------------------- */
  Parser.prototype.parseProgram = function () {
    const start = this.cur();
    const body = this.parseBlockBody(new Set());
    const prog = this.node("Program", { body: body, comments: this.comments }, start, this.prev());
    if (this.cur().type !== "eof") {
      const t = this.cur();
      throw new LuauSyntaxError("token tak terduga " + JSON.stringify(t.value), t.line, t.column);
    }
    return prog;
  };
  Parser.prototype.parseBlock = function (until) {
    const start = this.cur();
    const body = this.parseBlockBody(until);
    return this.node("Block", { body: body }, start, this.prev());
  };
  Parser.prototype.parseBlockBody = function (until) {
    const body = [];
    while (this.cur().type !== "eof" && !until.has(this.cur().value)) {
      const st = this.parseStatement();
      if (st) body.push(st);
    }
    return body;
  };

  /* ------------------------------ pernyataan --------------------------- */
  Parser.prototype.parseStatement = function () {
    const t = this.cur();
    if (this.isOp(";")) { this.next(); return null; }
    if (t.type === "keyword") {
      switch (t.value) {
        case "if":       return this.parseIf();
        case "while":    return this.parseWhile();
        case "do":       return this.parseDo();
        case "for":      return this.parseFor();
        case "repeat":   return this.parseRepeat();
        case "function": return this.parseFunctionStatement(false, null);
        case "local":    return this.parseLocal();
        case "return":   return this.parseReturn();
        case "break":    this.next(); return this.node("BreakStatement", {}, t, t);
        case "continue": this.next(); return this.node("ContinueStatement", {}, t, t);
        case "type":
          // 'type' adalah keyword kontekstual: hanya alias bila diikuti nama lalu '=' / '<'
          if (this.peek(1).type === "ident" &&
              this.peek(2).type === "op" &&
              (this.peek(2).value === "=" || this.peek(2).value === "<")) {
            return this.parseTypeAlias(false);
          }
          break;
        case "export":
          if (this.peek(1).type === "keyword" && this.peek(1).value === "type") {
            return this.parseTypeAlias(true);
          }
          break;
      }
    }
    return this.parseExpressionStatement();
  };

  Parser.prototype.assertAssignable = function (target) {
    if (target.type !== "Identifier" && target.type !== "MemberExpression" && target.type !== "IndexExpression") {
      throw new LuauSyntaxError("target assignment tidak valid (" + target.type + ")", target.line, target.column);
    }
  };

  Parser.prototype.parseExpressionStatement = function () {
    const start = this.cur();
    const first = this.parseSuffixedExpression();
    if (this.isOp(",") || (this.isOp() && ASSIGN_OPS.has(this.cur().value))) {
      const targets = [first];
      while (this.isOp(",")) { this.next(); targets.push(this.parseSuffixedExpression()); }
      const opTok = this.next();
      if (!ASSIGN_OPS.has(opTok.value)) {
        throw new LuauSyntaxError("diharapkan operator assignment", opTok.line, opTok.column);
      }
      for (let k = 0; k < targets.length; k++) this.assertAssignable(targets[k]);
      const values = this.parseExpressionList();
      return this.node("AssignmentStatement", { targets: targets, operator: opTok.value, values: values }, start, this.prev());
    }
    if (first.type === "CallExpression") {
      return this.node("CallStatement", { expression: first }, start, this.prev());
    }
    throw new LuauSyntaxError("syntax error: ekspresi bukan pemanggilan ataupun assignment",
      this.cur().line, this.cur().column);
  };

  Parser.prototype.parseReturn = function () {
    const start = this.next(); // 'return'
    let args = [];
    if (this.cur().type !== "eof" && !this.isOp(";") &&
        ["end", "else", "elseif", "until"].indexOf(this.cur().value) === -1) {
      args = this.parseExpressionList();
    }
    if (this.isOp(";")) this.next();
    return this.node("ReturnStatement", { arguments: args }, start, this.prev());
  };

  Parser.prototype.parseIf = function () {
    const start = this.next(); // 'if'
    const clauses = [];
    let condition = this.parseExpression();
    this.expect("keyword", "then", "'then'");
    let body = this.parseBlock(new Set(["elseif", "else", "end"]));
    clauses.push({ condition: condition, body: body });
    while (this.isKw("elseif")) {
      this.next();
      condition = this.parseExpression();
      this.expect("keyword", "then", "'then'");
      body = this.parseBlock(new Set(["elseif", "else", "end"]));
      clauses.push({ condition: condition, body: body });
    }
    let elseBody = null;
    if (this.isKw("else")) { this.next(); elseBody = this.parseBlock(new Set(["end"])); }
    const endTok = this.expect("keyword", "end", "'end'");
    return this.node("IfStatement", { clauses: clauses, else: elseBody }, start, endTok);
  };

  Parser.prototype.parseWhile = function () {
    const start = this.next(); // 'while'
    const condition = this.parseExpression();
    this.expect("keyword", "do", "'do'");
    const body = this.parseBlock(new Set(["end"]));
    const endTok = this.expect("keyword", "end", "'end'");
    return this.node("WhileStatement", { condition: condition, body: body }, start, endTok);
  };

  Parser.prototype.parseDo = function () {
    const start = this.next(); // 'do'
    const body = this.parseBlock(new Set(["end"]));
    const endTok = this.expect("keyword", "end", "'end'");
    return this.node("DoStatement", { body: body }, start, endTok);
  };

  Parser.prototype.parseRepeat = function () {
    const start = this.next(); // 'repeat'
    const body = this.parseBlock(new Set(["until"]));
    this.expect("keyword", "until", "'until'");
    const condition = this.parseExpression();
    return this.node("RepeatStatement", { body: body, condition: condition }, start, this.prev());
  };

  Parser.prototype.parseForVar = function () {
    const nameTok = this.expect("ident", undefined, "nama variabel");
    let type = null;
    if (this.isOp(":")) { this.next(); type = this.parseType(); }
    return { name: nameTok.value, type: type };
  };

  Parser.prototype.parseFor = function () {
    const start = this.next(); // 'for'
    const firstVar = this.parseForVar();
    if (this.isOp("=")) {
      this.next();
      const from = this.parseExpression();
      this.expect("op", ",");
      const to = this.parseExpression();
      let step = null;
      if (this.isOp(",")) { this.next(); step = this.parseExpression(); }
      this.expect("keyword", "do", "'do'");
      const body = this.parseBlock(new Set(["end"]));
      const endTok = this.expect("keyword", "end", "'end'");
      return this.node("NumericForStatement", {
        variable: firstVar, start: from, end: to, step: step, body: body,
      }, start, endTok);
    }
    const variables = [firstVar];
    while (this.isOp(",")) { this.next(); variables.push(this.parseForVar()); }
    this.expect("keyword", "in", "'in'");
    const iterators = this.parseExpressionList();
    this.expect("keyword", "do", "'do'");
    const body = this.parseBlock(new Set(["end"]));
    const endTok = this.expect("keyword", "end", "'end'");
    return this.node("GenericForStatement", { variables: variables, iterators: iterators, body: body }, start, endTok);
  };

  Parser.prototype.parseLocal = function () {
    const start = this.next(); // 'local'
    if (this.isKw("function")) return this.parseFunctionStatement(true, start);
    const names = [];
    do {
      const nameTok = this.expect("ident", undefined, "nama variabel");
      let attribute = null;
      if (this.isOp("<")) {
        this.next();
        const a = this.expect("ident", undefined, "'const' atau 'close'");
        if (a.value !== "const" && a.value !== "close") {
          throw new LuauSyntaxError("atribut harus 'const' atau 'close'", a.line, a.column);
        }
        attribute = a.value;
        this.expect("op", ">");
      }
      let type = null;
      if (this.isOp(":")) { this.next(); type = this.parseType(); }
      names.push({ name: nameTok.value, attribute: attribute, type: type });
    } while (this.isOp(",") && this.next());
    let init = [];
    if (this.isOp("=")) { this.next(); init = this.parseExpressionList(); }
    return this.node("LocalStatement", { names: names, init: init }, start, this.prev());
  };

  Parser.prototype.parseFunctionStatement = function (isLocal, startTok) {
    const start = startTok || this.cur(); // token 'function' (atau 'local')
    this.expect("keyword", "function", "'function'");
    const baseTok = this.expect("ident", undefined, "nama fungsi");
    const base = this.node("Identifier", { name: baseTok.value }, baseTok, baseTok);
    const properties = [];
    while (this.isOp(".")) { this.next(); properties.push(this.expect("ident", undefined, "nama properti").value); }
    let method = null;
    if (this.isOp(":")) { this.next(); method = this.expect("ident", undefined, "nama method").value; }
    if (isLocal && (properties.length || method)) {
      throw new LuauSyntaxError("fungsi lokal tidak boleh memiliki nama berkualifikasi", start.line, start.column);
    }
    const generics = this.parseGenericTypeList();
    const fn = this.parseFunctionBody(start);
    return this.node("FunctionDeclaration", {
      isLocal: !!isLocal,
      name: base,
      properties: properties,
      method: method,
      generics: generics,
      parameters: fn.parameters,
      vararg: fn.vararg,
      varargType: fn.varargType,
      returnType: fn.returnType,
      body: fn.body,
    }, start, fn.endTok);
  };

  Parser.prototype.parseFunctionBody = function (start) {
    this.expect("op", "(", "'('");
    const parameters = [];
    let vararg = false, varargType = null;
    if (!this.isOp(")")) {
      for (;;) {
        if (this.isOp("...")) {
          this.next(); vararg = true;
          if (this.isOp(":")) { this.next(); varargType = this.parseType(); }
          break;
        }
        const p = this.expect("ident", undefined, "nama parameter");
        let type = null;
        if (this.isOp(":")) { this.next(); type = this.parseType(); }
        parameters.push({ name: p.value, type: type });
        if (!this.isOp(",")) break;
        this.next();
      }
    }
    this.expect("op", ")", "')'");
    let returnType = null;
    if (this.isOp(":")) { this.next(); returnType = this.parseType(); }
    const body = this.parseBlock(new Set(["end"]));
    const endTok = this.expect("keyword", "end", "'end'");
    return { parameters: parameters, vararg: vararg, varargType: varargType, returnType: returnType, body: body, endTok: endTok };
  };

  Parser.prototype.parseGenericTypeList = function () {
    if (!this.isOp("<")) return [];
    this.next();
    const generics = [];
    for (;;) {
      const nameTok = this.expect("ident", undefined, "nama parameter tipe");
      let variadic = false;
      if (this.isOp("...")) { this.next(); variadic = true; }
      generics.push({ name: nameTok.value, variadic: variadic });
      if (!this.isOp(",")) break;
      this.next();
    }
    this.expect("op", ">", "'>'");
    return generics;
  };

  /* ------------------------------ tipe Luau ---------------------------- */
  Parser.prototype.parseTypeAlias = function (isExport) {
    const start = this.next(); // 'type' / 'export'
    if (isExport) this.expect("keyword", "type", "'type'");
    const nameTok = this.expect("ident", undefined, "nama tipe");
    const generics = this.parseGenericTypeList();
    this.expect("op", "=");
    const type = this.parseType();
    return this.node("TypeAliasStatement", {
      export: isExport, name: nameTok.value, generics: generics, type: type,
    }, start, this.prev());
  };

  function mergeTypes(kind, left, right) {
    const flat = function (n) { return n.type === kind ? n.types : [n]; };
    return flat(left).concat(flat(right));
  }

  Parser.prototype.parseType = function () {
    let left = this.parseTypeIntersection();
    while (this.isOp("|")) {
      this.next();
      const right = this.parseTypeIntersection();
      left = this.mkSpan("UnionType", { types: mergeTypes("UnionType", left, right) }, left, right);
    }
    return left;
  };

  Parser.prototype.parseTypeIntersection = function () {
    let left = this.parseTypeAtom();
    while (this.isOp("&")) {
      this.next();
      const right = this.parseTypeAtom();
      left = this.mkSpan("IntersectionType", { types: mergeTypes("IntersectionType", left, right) }, left, right);
    }
    return left;
  };

  Parser.prototype.parseTypeAtom = function () {
    const t = this.cur();
    let node = null;
    if (this.isOp("(")) {
      node = this.parseParenOrFunctionType();
    } else if (this.isOp("{")) {
      node = this.parseTableType();
    } else if (t.type === "string") {
      this.next();
      node = this.node("LiteralType", { value: t.value.value, raw: t.value.raw }, t, t);
    } else if (t.type === "number") {
      this.next();
      node = this.node("LiteralType", { value: parseNumberValue(t.value), raw: t.value }, t, t);
    } else if (this.isKw("true") || this.isKw("false")) {
      this.next();
      node = this.node("LiteralType", { value: t.value === "true", raw: t.value }, t, t);
    } else if (this.isKw("nil")) {
      this.next();
      node = this.node("NilType", {}, t, t);
    } else if (t.type === "ident" && t.value === "typeof" &&
               this.peek(1).type === "op" && this.peek(1).value === "(") {
      this.next(); this.next();
      const expr = this.parseExpression();
      const endTok = this.expect("op", ")");
      node = this.node("TypeofType", { expression: expr }, t, endTok);
    } else if (t.type === "ident" || (t.type === "keyword" && (t.value === "any" || t.value === "never"))) {
      this.next();
      const path = [t.value];
      while (this.isOp(".")) { this.next(); path.push(this.expect("ident", undefined, "nama tipe").value); }
      node = this.node("NamedType", { name: path.join("."), path: path }, t, this.prev());
      if (this.isOp("<")) {
        this.next();
        const args = [];
        for (;;) { args.push(this.parseType()); if (!this.isOp(",")) break; this.next(); }
        const gt = this.expect("op", ">", "'>'");
        node = this.mkSpan("GenericType", { base: node, arguments: args }, node, gt);
      }
    } else {
      throw new LuauSyntaxError("tipe tidak dikenal " + JSON.stringify(t.value), t.line, t.column);
    }
    // suffix: ? (opsional) dan [] (array)
    for (;;) {
      if (this.isOp("?")) {
        this.next();
        node = this.mkSpan("OptionalType", { type: node }, node, this.prev());
      } else if (this.isOp("[") && this.peek(1).type === "op" && this.peek(1).value === "]") {
        this.next(); this.next();
        node = this.mkSpan("ArrayType", { elementType: node }, node, this.prev());
      } else if (this.isOp("...")) {
        // type pack: T...
        this.next();
        node = this.mkSpan("VariadicTypePack", { name: null, inner: node }, node, this.prev());
      } else break;
    }
    return node;
  };

  Parser.prototype.parseParenOrFunctionType = function () {
    const start = this.next(); // '('
    const params = [];
    let sawNamed = false;
    if (!this.isOp(")")) {
      for (;;) {
        if (this.isOp("...")) {
          this.next();
          let vt = null;
          if (this.isOp(":")) { this.next(); vt = this.parseType(); }
          params.push({ name: null, variadic: true, type: vt });
          break;
        }
        if (this.cur().type === "ident" && this.peek(1).type === "op" && this.peek(1).value === "...") {
          // type pack variadic: T...
          const nameTok = this.next();
          this.next();
          params.push({ name: null, variadic: false,
            type: this.node("VariadicTypePack", { name: nameTok.value }, nameTok, this.prev()) });
        } else if (this.cur().type === "ident" && this.peek(1).type === "op" && this.peek(1).value === ":") {
          sawNamed = true;
          const nameTok = this.next();
          this.next(); // ':'
          params.push({ name: nameTok.value, variadic: false, type: this.parseType() });
        } else {
          if (sawNamed) {
            throw new LuauSyntaxError("tidak boleh mencampur parameter tipe bernama dan tanpa nama",
              this.cur().line, this.cur().column);
          }
          params.push({ name: null, variadic: false, type: this.parseType() });
        }
        if (!this.isOp(",")) break;
        this.next();
      }
    }
    this.expect("op", ")");
    if (this.isOp("->")) {
      this.next();
      const ret = this.parseType();
      return this.node("FunctionType", { parameters: params, returnType: ret }, start, this.prev());
    }
    if (params.length !== 1 || params[0].name !== null || params[0].variadic) {
      throw new LuauSyntaxError("tipe dalam tanda kurung harus berisi tepat satu tipe", start.line, start.column);
    }
    return params[0].type;
  };

  Parser.prototype.parseTableType = function () {
    const start = this.next(); // '{'
    const fields = [];
    while (!this.isOp("}")) {
      let modifier = null;
      if (this.cur().type === "ident" && (this.cur().value === "read" || this.cur().value === "write") &&
          this.peek(1).type === "ident") {
        modifier = this.next().value;
      }
      if (this.isOp("[")) {
        this.next();
        const key = this.parseType();
        this.expect("op", "]");
        this.expect("op", ":");
        fields.push({ kind: "index", key: key, value: this.parseType(), modifier: modifier });
      } else {
        const nameTok = this.expect("ident", undefined, "nama field tabel");
        this.expect("op", ":");
        fields.push({ kind: "named", name: nameTok.value, value: this.parseType(), modifier: modifier });
      }
      if (this.isOp(",") || this.isOp(";")) this.next();
    }
    const endTok = this.expect("op", "}", "'}'");
    return this.node("TableType", { fields: fields }, start, endTok);
  };

  /* ------------------------------ ekspresi ----------------------------- */
  Parser.prototype.parseExpressionList = function () {
    const list = [this.parseExpression()];
    while (this.isOp(",")) { this.next(); list.push(this.parseExpression()); }
    return list;
  };

  Parser.prototype.parseExpression = function () { return this.parseSubexpression(0); };

  Parser.prototype.parseSubexpression = function (limit) {
    let left;
    const t = this.cur();
    if ((t.type === "keyword" || t.type === "op") && UNARY_OPS.has(t.value)) {
      const opTok = this.next();
      const operand = this.parseSubexpression(UNARY_PRIORITY);
      left = this.node("UnaryExpression", { operator: opTok.value, operand: operand }, opTok, this.prev());
    } else {
      left = this.parseSimpleExpression();
    }
    for (;;) {
      const b = this.cur();
      const pri = (b.type === "op" || b.type === "keyword") ? BINARY_PRIORITY[b.value] : null;
      if (!pri || pri[0] <= limit) break;
      const opTok = this.next();
      const right = this.parseSubexpression(pri[1]);
      left = this.mkSpan("BinaryExpression", { operator: opTok.value, left: left, right: right }, left, this.prev());
    }
    return left;
  };

  Parser.prototype.parseSimpleExpression = function () {
    const t = this.cur();
    switch (t.type) {
      case "number":
        this.next();
        return this.node("NumberLiteral", { value: parseNumberValue(t.value), raw: t.value }, t, t);
      case "string":
        return this.parseStringLiteral();
      case "keyword":
        switch (t.value) {
          case "nil":
            this.next();
            return this.node("NilLiteral", {}, t, t);
          case "true": case "false":
            this.next();
            return this.node("BooleanLiteral", { value: t.value === "true", raw: t.value }, t, t);
          case "function": {
            this.next();
            const generics = this.isOp("<") ? this.parseGenericTypeList() : [];
            const fn = this.parseFunctionBody(t);
            return this.node("FunctionExpression", {
              generics: generics,
              parameters: fn.parameters, vararg: fn.vararg, varargType: fn.varargType,
              returnType: fn.returnType, body: fn.body,
            }, t, fn.endTok);
          }
          case "if":
            return this.parseIfExpression();
        }
        break;
      case "op":
        if (t.value === "{") return this.parseTableConstructor();
        if (t.value === "...") { this.next(); return this.node("VarargLiteral", {}, t, t); }
        break;
      case "ident":
        break; // prefix expression
    }
    return this.parseSuffixedExpression();
  };

  Parser.prototype.parseStringLiteral = function () {
    const t = this.next();
    if (t.value.interpolated) {
      const parts = [];
      for (let k = 0; k < t.value.parts.length; k++) {
        const p = t.value.parts[k];
        if (p.type === "text") {
          parts.push({ type: "InterpolationText", value: p.value });
        } else {
          const sub = new Parser(p.tokens);
          const expr = sub.parseExpression();
          sub.expect("eof");
          parts.push({ type: "InterpolationExpression", expression: expr, source: p.source });
        }
      }
      return this.node("InterpStringExpression", { parts: parts }, t, t);
    }
    return this.node("StringLiteral", {
      value: t.value.value, raw: t.value.raw, long: t.value.raw.charAt(0) === "[",
    }, t, t);
  };

  Parser.prototype.parseIfExpression = function () {
    const start = this.next(); // 'if'
    const clauses = [];
    let condition = this.parseExpression();
    this.expect("keyword", "then", "'then'");
    clauses.push({ condition: condition, value: this.parseExpression() });
    while (this.isKw("elseif")) {
      this.next();
      condition = this.parseExpression();
      this.expect("keyword", "then", "'then'");
      clauses.push({ condition: condition, value: this.parseExpression() });
    }
    this.expect("keyword", "else", "'else'");
    const elseValue = this.parseExpression();
    return this.node("IfExpression", { clauses: clauses, else: elseValue }, start, this.prev());
  };

  Parser.prototype.parseTableConstructor = function () {
    const start = this.next(); // '{'
    const fields = [];
    while (!this.isOp("}")) {
      let field;
      if (this.isOp("[")) {
        this.next();
        const key = this.parseExpression();
        this.expect("op", "]");
        this.expect("op", "=");
        field = { kind: "key", key: key, value: this.parseExpression() };
      } else if (this.cur().type === "ident" && this.peek(1).type === "op" && this.peek(1).value === "=") {
        const keyTok = this.cur();
        const key = this.node("StringLiteral", { value: keyTok.value, raw: "\"" + keyTok.value + "\"", long: false }, keyTok, keyTok);
        this.next(); this.next();
        field = { kind: "named", key: key, value: this.parseExpression() };
      } else {
        field = { kind: "array", value: this.parseExpression() };
      }
      fields.push(field);
      if (this.isOp(",") || this.isOp(";")) this.next(); else break;
    }
    const endTok = this.expect("op", "}", "'}'");
    return this.node("TableConstructorExpression", { fields: fields }, start, endTok);
  };

  Parser.prototype.parseSuffixedExpression = function () {
    let base = this.parsePrimaryExpression();
    for (;;) {
      if (this.isOp(".")) {
        this.next();
        const nameTok = this.expect("ident", undefined, "nama setelah '.'");
        const prop = this.node("StringLiteral", { value: nameTok.value, raw: "\"" + nameTok.value + "\"", long: false }, nameTok, nameTok);
        base = this.mkSpan("MemberExpression", { object: base, property: prop, computed: false }, base, nameTok);
      } else if (this.isOp("[")) {
        this.next();
        const idx = this.parseExpression();
        const endTok = this.expect("op", "]", "']'");
        base = this.mkSpan("IndexExpression", { object: base, index: idx }, base, endTok);
      } else if (this.isOp(":")) {
        this.next();
        const nameTok = this.expect("ident", undefined, "nama method");
        const args = this.parseCallArgs();
        base = this.mkSpan("CallExpression", { callee: base, method: nameTok.value, arguments: args, kind: "method" }, base, this.prev());
      } else if (this.isOp("(") || this.isOp("{") || this.cur().type === "string") {
        const args = this.parseCallArgs();
        base = this.mkSpan("CallExpression", { callee: base, method: null, arguments: args, kind: "call" }, base, this.prev());
      } else break;
    }
    return base;
  };

  Parser.prototype.parseCallArgs = function () {
    if (this.isOp("(")) {
      this.next();
      const args = [];
      if (!this.isOp(")")) {
        const list = this.parseExpressionList();
        for (let k = 0; k < list.length; k++) args.push(list[k]);
      }
      this.expect("op", ")", "')'");
      return args;
    }
    if (this.isOp("{")) return [this.parseTableConstructor()];
    if (this.cur().type === "string") return [this.parseStringLiteral()];
    throw new LuauSyntaxError("argumen pemanggilan tidak valid", this.cur().line, this.cur().column);
  };

  Parser.prototype.parsePrimaryExpression = function () {
    const t = this.cur();
    if (t.type === "ident") {
      this.next();
      return this.node("Identifier", { name: t.value }, t, t);
    }
    if (this.isOp("(")) {
      this.next();
      const expr = this.parseExpression();
      const endTok = this.expect("op", ")", "')'");
      return this.node("ParenthesizedExpression", { expression: expr }, t, endTok);
    }
    throw new LuauSyntaxError("ekspresi tak terduga " + JSON.stringify(t.value), t.line, t.column);
  };

  /* ------------------------------ traversal ---------------------------- */
  function visitEach(list, visit) {
    if (!list) return;
    for (let k = 0; k < list.length; k++) {
      const item = list[k];
      if (!item) continue;
      if (typeof item.type === "string") visit(item);
      else {
        // objek pembungkus seperti {condition, body} / field tabel / nama local
        for (const key in item) {
          const v = item[key];
          if (v && typeof v === "object" && typeof v.type === "string") visit(v);
        }
      }
    }
  }

  function walk(root, callbacks) {
    const enter = (typeof callbacks === "function") ? callbacks : (callbacks && callbacks.enter) || null;
    const leave = (callbacks && callbacks.leave) || null;

    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (typeof node.type !== "string") {
        // objek pembungkus non-node (mis. klause if / field tabel / nama local):
        // jelajahi isinya tanpa memanggil callback
        for (const key in node) {
          const v = node[key];
          if (v && typeof v === "object") visit(v);
        }
        return;
      }
      if (enter) enter(node);
      switch (node.type) {
        case "Program": case "Block":
          visitEach(node.body, visit); break;
        case "LocalStatement":
          visitEach(node.names, visit); visitEach(node.init, visit); break;
        case "AssignmentStatement":
          visitEach(node.targets, visit); visitEach(node.values, visit); break;
        case "CallStatement":
          visit(node.expression); break;
        case "IfStatement":
          visitEach(node.clauses, visit);
          if (node.else) visit(node.else);
          break;
        case "WhileStatement":
          visit(node.condition); visit(node.body); break;
        case "DoStatement":
          visit(node.body); break;
        case "RepeatStatement":
          visit(node.body); visit(node.condition); break;
        case "NumericForStatement":
          visit(node.start); visit(node.end);
          if (node.step) visit(node.step);
          visit(node.body); break;
        case "GenericForStatement":
          visitEach(node.iterators, visit); visit(node.body); break;
        case "FunctionDeclaration": case "FunctionExpression":
          visit(node.name);
          visitEach(node.parameters, visit);
          if (node.returnType) visit(node.returnType);
          visit(node.body); break;
        case "ReturnStatement":
          visitEach(node.arguments, visit); break;
        case "TypeAliasStatement":
          visit(node.type); break;
        case "IfExpression":
          visitEach(node.clauses, visit);
          visit(node.else); break;
        case "UnaryExpression":
          visit(node.operand); break;
        case "BinaryExpression":
          visit(node.left); visit(node.right); break;
        case "MemberExpression":
          visit(node.object); visit(node.property); break;
        case "IndexExpression":
          visit(node.object); visit(node.index); break;
        case "CallExpression":
          visit(node.callee); visitEach(node.arguments, visit); break;
        case "TableConstructorExpression":
          visitEach(node.fields, visit); break;
        case "ParenthesizedExpression":
          visit(node.expression); break;
        case "InterpStringExpression":
          visitEach(node.parts, visit); break;
        case "UnionType": case "IntersectionType":
          visitEach(node.types, visit); break;
        case "OptionalType":
          visit(node.type); break;
        case "ArrayType":
          visit(node.elementType); break;
        case "GenericType":
          visit(node.base); visitEach(node.arguments, visit); break;
        case "FunctionType":
          visitEach(node.parameters, visit); visit(node.returnType); break;
        case "TableType":
          visitEach(node.fields, visit); break;
        case "TypeofType":
          visit(node.expression); break;
        case "VariadicTypePack":
          if (node.inner) visit(node.inner); break;
        // leaf: Identifier, NumberLiteral, StringLiteral, BooleanLiteral,
        //       NilLiteral, VarargLiteral, LiteralType, NilType,
        //       BreakStatement, ContinueStatement
      }
      if (leave) leave(node);
    }

    visit(root);
    return root;
  }

  /* ------------------------------ API utama ---------------------------- */
  function parse(source) {
    const parser = new Parser(tokenize(source));
    return parser.parseProgram();
  }

  return {
    VERSION: VERSION,
    parse: parse,
    tokenize: tokenize,
    walk: walk,
    LuauSyntaxError: LuauSyntaxError,
    KEYWORDS: KEYWORDS,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = LuauAST;
if (typeof globalThis !== "undefined") globalThis.LuauAST = LuauAST;
