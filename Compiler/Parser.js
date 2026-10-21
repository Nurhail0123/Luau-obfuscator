/**
 * luau_parser.js — Luau Lexer + Recursive-Descent Parser (JavaScript)
 * ---------------------------------------------------------------
 * Menghasilkan AST bergaya ESTree yang diperluas untuk Luau.
 * Cocok sebagai komponen front-end obfuscator Luau (Roblox / Delta Executor).
 *
 * Fitur yang didukung:
 *  - Semua statement/expression Lua 5.1 + ekstensi Luau:
 *    continue, compound assignment (+=, -=, *=, /=, //=, %=, ^=, ..=),
 *    integer division (//), string interpolation (backtick `...{expr}...`),
 *    type annotations (local x: T, parameter, return type -> T),
 *    type cast (expr :: T), type alias (type / export type) dengan generics,
 *    generic function (function f<T>(x: T) end, panggilan f<T>(...)),
 *    type packs (T...), union/intersection (|, &), table types, typeof(T),
 *    attributes (@native, @checked, @deprecated("...")),
 *    shebang (#!...), long string/comment ([==[ ]==]),
 *    escape lengkap (\x, \u{...}, \z, \ddd, named escapes).
 *
 * Catatan: parser ini syntactic-only (tidak melakukan scope/name resolution).
 */

'use strict';

/* ============================ Error ============================ */

class LuauSyntaxError extends Error {
  constructor(message, line, column) {
    super('[' + line + ':' + column + '] ' + message);
    this.name = 'LuauSyntaxError';
    this.line = line;
    this.column = column;
  }
}

/* ============================ Keyword ============================ */

const KEYWORDS = new Set([
  'and', 'break', 'continue', 'do', 'else', 'elseif', 'end', 'false', 'for',
  'function', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return',
  'then', 'true', 'until', 'while'
]);

// 'type', 'export', 'typeof' bersifat kontekstual — tetap token Name.

/* ============================ Symbols ============================ */

const SYMBOLS = [
  '...', '..=', '::', '<<', '>>', '//=',
  '+=', '-=', '*=', '/=', '%=', '^=', '==', '~=', '<=', '>=', '->', '//', '..',
  '+', '-', '*', '/', '%', '^', '#', '&', '~', '|', '<', '>',
  '(', ')', '{', '}', '[', ']', ';', ':', ',', '.', '=', '@', '?'
].sort(function (a, b) { return b.length - a.length; }); // longest-first

/* ============================ Lexer ============================ */

class Lexer {
  constructor(source) {
    this.src = String(source);
    this.pos = 0;
    this.line = 1;
    this.col = 1;
    this.modes = ['code'];        // stack: 'code' | 'interp'
    this.interp = [];             // stack brace-depth utk ekspresi di dalam `{ }` interpolasi
    this.pending = [];            // antrian token (utk InterpPart sebelum control token)
    this.comments = [];           // buffer komentar (jika captureComments)
  }

  error(msg) { throw new LuauSyntaxError(msg, this.line, this.col); }

  peek(off) { return this.src[this.pos + (off || 0)]; }

  advance() {
    const c = this.src[this.pos];
    this.pos++;
    if (c === '\n') { this.line++; this.col = 1; } else { this.col++; }
    return c;
  }

  tok(type, value, line, col, extra) {
    const t = { type: type, value: value, line: line, column: col };
    if (extra) for (const k in extra) t[k] = extra[k];
    return t;
  }

  /* --- state save/restore utk backtracking (generic call `<T>(`) --- */
  save() {
    return {
      pos: this.pos, line: this.line, col: this.col,
      modes: this.modes.slice(),
      interp: this.interp.map(function (d) { return { depth: d.depth }; }),
      pending: this.pending.slice(),
      comments: this.comments.slice()
    };
  }
  restore(s) {
    this.pos = s.pos; this.line = s.line; this.col = s.col;
    this.modes = s.modes; this.interp = s.interp;
    this.pending = s.pending; this.comments = s.comments;
  }

  /* --- trivia: whitespace + komentar --- */
  skipTrivia(capture) {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\v' || c === '\f') { this.advance(); continue; }
      if (c === '-' && this.peek(1) === '-') {
        const cl = this.line, cc = this.col;
        this.advance(); this.advance();
        if (this.peek() === '[') {
          const lvl = this.longBracketLevel();
          if (lvl !== null) { this.readLongBracket(lvl); if (capture) this.pushComment(cl, cc, '--' + this._lastLongRaw); continue; }
        }
        let text = '';
        while (this.pos < this.src.length && this.peek() !== '\n') text += this.advance();
        if (capture) this.pushComment(cl, cc, '--' + text);
        continue;
      }
      break;
    }
  }
  pushComment(line, col, text) { this.comments.push({ type: 'Comment', value: text, line: line, column: col }); }

  /* --- long bracket: level '=' atau null --- */
  longBracketLevel() {
    if (this.peek() !== '[') return null;
    let i = 1, eq = 0;
    while (this.peek(i) === '=') { eq++; i++; }
    return this.peek(i) === '[' ? eq : null;
  }
  readLongBracket(level) {
    // posisi di '[' pembuka
    let raw = '';
    raw += this.advance();                       // [
    for (let i = 0; i < level; i++) raw += this.advance();
    raw += this.advance();                       // [
    const close = ']' + '='.repeat(level) + ']';
    const start = this.pos;
    const idx = this.src.indexOf(close, this.pos);
    if (idx === -1) this.error('unfinished long bracket');
    let content = '';
    while (this.pos < idx) content += this.advance();
    for (let i = 0; i < close.length; i++) raw += this.advance();
    if (content.length > 0 && content[0] === '\n') { content = content.slice(1); }
    this._lastLongRaw = raw;
    this._lastLongContent = content;
    return content;
  }

  /* --- escape sequence --- */
  readEscape(interp) {
    const raw = this.advance(); // '\'
    const e = this.peek();
    if (e === undefined) this.error('unfinished string');
    const named = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'" };
    if (named[e] !== undefined) { this.advance(); return { value: named[e], raw: raw + e }; }
    if (e === '\n') { this.advance(); return { value: '\n', raw: raw + '\n' }; }
    if (e === 'z') {
      this.advance();
      while (/\s/.test(this.peek() || '')) this.advance();
      return { value: '', raw: raw + 'z' };
    }
    if (e === 'x') {
      this.advance();
      const h1 = this.peek(), h2 = this.peek(1);
      if (!/[0-9a-fA-F]/.test(h1) || !/[0-9a-fA-F]/.test(h2)) this.error('invalid hex escape');
      const v = String.fromCharCode(parseInt(h1 + h2, 16));
      this.advance(); this.advance();
      return { value: v, raw: raw + 'x' + h1 + h2 };
    }
    if (e === 'u') {
      this.advance();
      if (this.peek() !== '{') this.error("expected '{' in \\u escape");
      this.advance();
      let hex = '';
      while (this.peek() !== '}') {
        const c = this.peek();
        if (!/[0-9a-fA-F]/.test(c || '')) this.error('invalid unicode escape');
        hex += this.advance();
      }
      this.advance(); // }
      return { value: String.fromCodePoint(parseInt(hex, 16)), raw: raw + 'u{' + hex + '}' };
    }
    if (interp && (e === '{' || e === '`')) { this.advance(); return { value: e, raw: raw + e }; }
    if (/[0-9]/.test(e)) {
      let d = '';
      for (let i = 0; i < 3 && /[0-9]/.test(this.peek() || ''); i++) d += this.advance();
      return { value: String.fromCharCode(parseInt(d, 10) & 0xff), raw: raw + d };
    }
    this.error("invalid escape sequence '\\" + e + "'");
  }

  /* --- string kutip tunggal/ganda --- */
  readQuotedString(quote) {
    const line = this.line, col = this.col;
    let raw = '', value = '';
    raw += this.advance(); // quote
    for (;;) {
      const c = this.peek();
      if (c === undefined) this.error('unfinished string');
      if (c === quote) { raw += this.advance(); return this.tok('String', value, line, col, { raw: raw }); }
      if (c === '\n') this.error('unfinished string');
      if (c === '\\') { const r = this.readEscape(false); value += r.value; raw += r.raw; continue; }
      raw += c; value += this.advance();
    }
  }

  /* --- angka --- */
  readNumber() {
    const line = this.line, col = this.col;
    let raw = '';
    if (this.peek() === '0' && /[xX]/.test(this.peek(1) || '')) {
      raw += this.advance(); raw += this.advance();
      while (/[0-9a-fA-F_]/.test(this.peek() || '')) raw += this.advance();
      if (this.peek() === '.' && /[0-9a-fA-F_]/.test(this.peek(1) || '')) { raw += this.advance(); while (/[0-9a-fA-F_]/.test(this.peek() || '')) raw += this.advance(); }
      if (/[pP]/.test(this.peek() || '')) { raw += this.advance(); if (/[+-]/.test(this.peek() || '')) raw += this.advance(); while (/[0-9_]/.test(this.peek() || '')) raw += this.advance(); }
    } else if (this.peek() === '0' && /[bB]/.test(this.peek(1) || '')) {
      raw += this.advance(); raw += this.advance();
      while (/[01_]/.test(this.peek() || '')) raw += this.advance();
    } else {
      while (/[0-9_]/.test(this.peek() || '')) raw += this.advance();
      if (this.peek() === '.' && /[0-9_]/.test(this.peek(1) || '')) { raw += this.advance(); while (/[0-9_]/.test(this.peek() || '')) raw += this.advance(); }
      if (/[eE]/.test(this.peek() || '')) {
        const save = this.pos;
        raw += this.advance();
        if (/[+-]/.test(this.peek() || '')) raw += this.advance();
        if (/[0-9_]/.test(this.peek() || '')) { while (/[0-9_]/.test(this.peek() || '')) raw += this.advance(); }
        else { this.pos = save; raw = raw.slice(0, -1); }
      }
    }
    const cleaned = raw.replace(/_/g, '');
    let value;
    try { value = Number(cleaned); if (Number.isNaN(value)) value = cleaned; } catch (_) { value = cleaned; }
    return this.tok('Number', value, line, col, { raw: raw });
  }

  /* --- nama / keyword --- */
  readName() {
    const line = this.line, col = this.col;
    let name = '';
    while (/[A-Za-z0-9_]/.test(this.peek() || '')) name += this.advance();
    if (KEYWORDS.has(name)) return this.tok('Keyword', name, line, col);
    return this.tok('Name', name, line, col);
  }

  /* --- token di mode kode --- */
  readCodeToken() {
    const line = this.line, col = this.col;
    const c = this.peek();
    if (/[A-Za-z_]/.test(c)) return this.readName();
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(this.peek(1) || ''))) return this.readNumber();
    if (c === '"' || c === "'") return this.readQuotedString(c);
    if (c === '`') { this.advance(); this.modes.push('interp'); return this.tok('InterpBegin', '`', line, col); }
    if (c === '[') {
      const lvl = this.longBracketLevel();
      if (lvl !== null) {
        const content = this.readLongBracket(lvl);
        return this.tok('String', content, line, col, { raw: this._lastLongRaw, long: true });
      }
    }
    if (c === '}' && this.interp.length) {
      this.advance();
      const top = this.interp[this.interp.length - 1];
      if (top.depth === 0) { this.interp.pop(); this.modes.pop(); return this.tok('InterpExprEnd', '}', line, col); }
      top.depth--;
      return this.tok('Symbol', '}', line, col);
    }
    if (c === '{') {
      this.advance();
      if (this.interp.length) this.interp[this.interp.length - 1].depth++;
      return this.tok('Symbol', '{', line, col);
    }
    for (let i = 0; i < SYMBOLS.length; i++) {
      const s = SYMBOLS[i];
      if (this.src.startsWith(s, this.pos)) {
        for (let j = 0; j < s.length; j++) this.advance();
        return this.tok('Symbol', s, line, col);
      }
    }
    this.error("unexpected character '" + c + "'");
  }

  /* --- token di mode teks interpolasi (di dalam backtick) --- */
  readInterpPart() {
    const line = this.line, col = this.col;
    let text = '', raw = '';
    for (;;) {
      const c = this.peek();
      if (c === undefined) this.error('unfinished interpolated string');
      if (c === '\\') { const r = this.readEscape(true); text += r.value; raw += r.raw; continue; }
      if (c === '`') {
        this.advance(); this.modes.pop();
        if (raw.length) { this.pending.push(this.tok('InterpEnd', '`', this.line, this.col)); return this.tok('InterpPart', text, line, col, { raw: raw }); }
        return this.tok('InterpEnd', '`', line, col);
      }
      if (c === '{') {
        this.advance(); this.interp.push({ depth: 0 }); this.modes.push('code');
        if (raw.length) { this.pending.push(this.tok('InterpExprBegin', '{', this.line, this.col)); return this.tok('InterpPart', text, line, col, { raw: raw }); }
        return this.tok('InterpExprBegin', '{', line, col);
      }
      raw += c; text += this.advance();
    }
  }

  next(captureComments) {
    if (this.pending.length) return this.pending.shift();
    if (this.pos === 0 && this.src.startsWith('#!')) {
      while (this.pos < this.src.length && this.peek() !== '\n') this.advance();
    }
    this.skipTrivia(captureComments);
    if (this.pos >= this.src.length) return this.tok('EOF', '<eof>', this.line, this.col);
    if (this.modes[this.modes.length - 1] === 'interp') return this.readInterpPart();
    return this.readCodeToken();
  }
}

/* ============================ Parser ============================ */

const BIN_PRIORITY = {
  'or': [1, 1], 'and': [2, 2],
  '<': [3, 3], '>': [3, 3], '<=': [3, 3], '>=': [3, 3], '~=': [3, 3], '==': [3, 3],
  '|': [4, 4], '~': [5, 5], '&': [6, 6],
  '<<': [7, 7], '>>': [7, 7],
  '..': [8, 7],                 // right-assoc
  '+': [9, 9], '-': [9, 9],
  '*': [10, 10], '/': [10, 10], '//': [10, 10], '%': [10, 10],
  '^': [12, 11]                 // right-assoc
};

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '//=', '%=', '^=', '..=']);
const UNARY_OPS = new Set(['not', '#', '-', '~']);
const BLOCK_END = new Set(['end', 'else', 'elseif', 'until']);

function id(tok) { return { type: 'Identifier', name: tok.value, loc: { line: tok.line, column: tok.column } }; }
function node(type, props, tok) {
  const n = { type: type };
  for (const k in props) n[k] = props[k];
  n.loc = { line: tok.line, column: tok.column };
  return n;
}

class Parser {
  constructor(source, options) {
    this.l = new Lexer(source);
    this.options = options || {};
    this.tok = this.l.next(this.options.captureComments);
    this._peek = null;
    this.pendingAttributes = null;
  }

  /* --- token plumbing --- */
  advance() { const t = this.tok; this.tok = this._peek || this.l.next(this.options.captureComments); this._peek = null; return t; }
  peekToken() { if (!this._peek) this._peek = this.l.next(this.options.captureComments); return this._peek; }
  is(v) { return this.tok.value === v; }
  isType(t) { return this.tok.type === t; }
  error(msg, tok) { tok = tok || this.tok; throw new LuauSyntaxError(msg, tok.line, tok.column); }
  expect(v) { if (this.tok.value !== v) this.error("expected '" + v + "' but got '" + this.tok.value + "'"); return this.advance(); }
  expectName() { if (this.tok.type !== 'Name') this.error("expected identifier but got '" + this.tok.value + "'"); return this.advance(); }
  takeComments() { const c = this.l.comments; this.l.comments = []; return c; }

  mark() { return { l: this.l.save(), tok: this.tok, peek: this._peek }; }
  restore(m) { this.l.restore(m.l); this.tok = m.tok; this._peek = m.peek; }

  /* ================= Chunk / Block / Statement ================= */

  parseChunk() {
    const body = [];
    while (!this.isType('EOF')) {
      if (this.is(';')) { this.advance(); continue; }
      body.push(this.parseStatement());
    }
    const chunk = { type: 'Chunk', body: body, loc: { line: 1, column: 1 } };
    const c = this.takeComments();
    if (c.length && this.options.captureComments) chunk.trailingComments = c;
    return chunk;
  }

  parseBlock(terminators) {
    const body = [];
    for (;;) {
      if (this.isType('EOF')) this.error('unexpected end of file');
      if (terminators.has(this.tok.value)) break;
      if (this.is(';')) { this.advance(); continue; }
      body.push(this.parseStatement());
    }
    return body;
  }

  parseStatement() {
    const comments = this.takeComments();
    const stmt = this.parseStatementCore();
    if (comments.length && this.options.captureComments) stmt.leadingComments = comments;
    return stmt;
  }

  parseStatementCore() {
    if (this.is('@')) { this.pendingAttributes = this.parseAttributes(); return this.parseStatementCore(); }
    const t = this.tok;
    if (t.type === 'Keyword') {
      switch (t.value) {
        case 'if': return this.parseIf();
        case 'while': return this.parseWhile();
        case 'do': return this.parseDo();
        case 'for': return this.parseFor();
        case 'repeat': return this.parseRepeat();
        case 'function': return this.parseFunctionDeclaration();
        case 'local': return this.parseLocal();
        case 'return': return this.parseReturn();
        case 'break': { const b = this.advance(); return node('BreakStatement', {}, b); }
        case 'continue': { const b = this.advance(); return node('ContinueStatement', {}, b); }
      }
    }
    if (t.type === 'Name') {
      if (t.value === 'type' && this.peekToken().type === 'Name') return this.parseTypeAlias(false);
      if (t.value === 'export' && this.peekToken().value === 'type') return this.parseTypeAlias(true);
      return this.parseExprStatementOrAssign();
    }
    this.error("unexpected symbol '" + t.value + "'");
  }

  parseAttributes() {
    const attrs = [];
    while (this.is('@')) {
      this.advance();
      const name = this.expectName().value;
      let args = null;
      if (this.is('(')) {
        this.advance();
        args = [];
        while (!this.is(')')) {
          if (this.isType('String')) args.push({ kind: 'string', value: this.advance().value });
          else if (this.isType('Number')) args.push({ kind: 'number', value: this.advance().value });
          else this.error('attribute arguments must be literals');
          if (this.is(',')) { this.advance(); continue; }
          break;
        }
        this.expect(')');
      }
      attrs.push({ name: name, args: args });
    }
    return attrs;
  }

  parseIf() {
    const start = this.expect('if');
    const clauses = [];
    clauses.push({ condition: this.parseExpr(), body: (this.expect('then'), this.parseBlock(BLOCK_END)) });
    while (this.is('elseif')) {
      this.advance();
      const c = this.parseExpr();
      this.expect('then');
      clauses.push({ condition: c, body: this.parseBlock(BLOCK_END) });
    }
    let elseBody = null;
    if (this.is('else')) { this.advance(); elseBody = this.parseBlock(new Set(['end'])); }
    this.expect('end');
    return node('IfStatement', { clauses: clauses, elseBody: elseBody }, start);
  }

  parseWhile() {
    const start = this.expect('while');
    const condition = this.parseExpr();
    this.expect('do');
    const body = this.parseBlock(BLOCK_END);
    this.expect('end');
    return node('WhileStatement', { condition: condition, body: body }, start);
  }

  parseDo() {
    const start = this.expect('do');
    const body = this.parseBlock(BLOCK_END);
    this.expect('end');
    return node('DoStatement', { body: body }, start);
  }

  parseRepeat() {
    const start = this.expect('repeat');
    const body = this.parseBlock(new Set(['until']));
    this.expect('until');
    const condition = this.parseExpr();
    return node('RepeatStatement', { body: body, condition: condition }, start);
  }

  parseFor() {
    const start = this.expect('for');
    const first = this.expectName();
    if (this.is('=')) {
      this.advance();
      const begin = this.parseExpr();
      this.expect(',');
      const end = this.parseExpr();
      let step = null;
      if (this.is(',')) { this.advance(); step = this.parseExpr(); }
      this.expect('do');
      const body = this.parseBlock(BLOCK_END);
      this.expect('end');
      return node('ForNumericStatement', { variable: id(first), start: begin, end: end, step: step, body: body }, start);
    }
    const variables = [id(first)];
    while (this.is(',')) { this.advance(); variables.push(id(this.expectName())); }
    this.expect('in');
    const iterators = this.parseExprList();
    this.expect('do');
    const body = this.parseBlock(BLOCK_END);
    this.expect('end');
    return node('ForGenericStatement', { variables: variables, iterators: iterators, body: body }, start);
  }

  parseReturn() {
    const start = this.expect('return');
    let args = [];
    if (!this.is(';') && !BLOCK_END.has(this.tok.value) && !this.isType('EOF')) args = this.parseExprList();
    return node('ReturnStatement', { arguments: args }, start);
  }

  parseLocal() {
    const start = this.expect('local');
    const attrs = this.pendingAttributes || []; this.pendingAttributes = null;
    if (this.is('function')) {
      this.advance();
      const name = this.expectName();
      const body = this.parseFunctionBody();
      return node('FunctionDeclaration', {
        isLocal: true, isMethod: false, name: id(name), attributes: attrs,
        generics: body.generics, params: body.params, returnType: body.returnType, body: body.body
      }, start);
    }
    const names = [];
    for (;;) {
      const n = this.expectName();
      let ann = null;
      if (this.is(':')) { this.advance(); ann = this.parseType(); }
      names.push({ type: 'LocalName', name: n.value, annotation: ann, loc: { line: n.line, column: n.column } });
      if (this.is(',')) { this.advance(); continue; }
      break;
    }
    let init = [];
    if (this.is('=')) { this.advance(); init = this.parseExprList(); }
    return node('LocalStatement', { names: names, init: init }, start);
  }

  parseFunctionDeclaration() {
    const start = this.expect('function');
    const attrs = this.pendingAttributes || []; this.pendingAttributes = null;
    let name = id(this.expectName());
    while (this.is('.')) { this.advance(); name = node('MemberExpression', { object: name, property: id(this.expectName()), computed: false }, start); }
    let isMethod = false;
    if (this.is(':')) { this.advance(); name = node('MemberExpression', { object: name, property: id(this.expectName()), computed: false }, start); isMethod = true; }
    const body = this.parseFunctionBody();
    return node('FunctionDeclaration', {
      isLocal: false, isMethod: isMethod, name: name, attributes: attrs,
      generics: body.generics, params: body.params, returnType: body.returnType, body: body.body
    }, start);
  }

  parseTypeAlias(exported) {
    const start = this.tok;
    this.advance(); // 'type'  (atau 'export'; 'type' ikut terkonsumsi di bawah)
    if (exported) this.expect('type');
    const name = this.expectName();
    const generics = this.is('<') ? this.parseGenericTypeParams() : null;
    this.expect('=');
    const value = this.parseType();
    return node('TypeAliasStatement', { exported: !!exported, name: name.value, generics: generics, value: value }, start);
  }

  parseExprStatementOrAssign() {
    const first = this.parseSuffixedExp();
    if (this.is(',')) {
      const targets = [first];
      while (this.is(',')) { this.advance(); targets.push(this.parseSuffixedExp()); }
      const opTok = this.advance();
      if (!ASSIGN_OPS.has(opTok.value)) this.error('expected assignment operator after assignment target list');
      return node('AssignmentStatement', { targets: targets, operator: opTok.value, values: this.parseExprList() }, opTok);
    }
    if (ASSIGN_OPS.has(this.tok.value)) {
      const op = this.advance();
      return node('AssignmentStatement', { targets: [first], operator: op.value, values: this.parseExprList() }, op);
    }
    if (first.type === 'CallExpression') return { type: 'ExpressionStatement', expression: first, loc: first.loc };
    this.error("syntax error: '" + (first.type === 'Identifier' ? first.name : first.type) + "' is not a valid statement");
  }

  /* ================= Function bodies ================= */

  parseFunctionBody() {
    const generics = this.is('<') ? this.parseGenericTypeParams() : null;
    this.expect('(');
    const params = [];
    while (!this.is(')')) {
      if (this.is('...')) {
        const d = this.advance();
        let ann = null;
        if (this.is(':')) { this.advance(); ann = this.parseType(); }
        params.push({ type: 'Parameter', name: '...', vararg: true, annotation: ann, loc: { line: d.line, column: d.column } });
        if (this.is(',')) this.advance();
        break;
      }
      const n = this.expectName();
      let ann = null;
      if (this.is(':')) { this.advance(); ann = this.parseType(); }
      params.push({ type: 'Parameter', name: n.value, vararg: false, annotation: ann, loc: { line: n.line, column: n.column } });
      if (this.is(',')) { this.advance(); continue; }
      break;
    }
    this.expect(')');
    let returnType = null;
    if (this.is(':')) { this.advance(); returnType = this.parseReturnType(); }
    const body = this.parseBlock(BLOCK_END);
    this.expect('end');
    return { generics: generics, params: params, returnType: returnType, body: body };
  }

  /* ================= Types ================= */

  parseGenericTypeParams() {
    this.expect('<');
    const params = [];
    for (;;) {
      const n = this.expectName();
      let pack = false;
      if (this.is('...')) { this.advance(); pack = true; }
      params.push({ name: n.value, pack: pack });
      if (this.is(',')) { this.advance(); continue; }
      break;
    }
    this.expect('>');
    return params;
  }

  parseGenericTypeArgs() {
    this.expect('<');
    const args = [];
    for (;;) {
      let t = this.parseType();
      if (this.is('...')) { this.advance(); t = { type: 'TypePack', inner: t, loc: t.loc }; }
      args.push(t);
      if (this.is(',')) { this.advance(); continue; }
      break;
    }
    this.expect('>');
    return args;
  }

  parseTypeList() {
    const items = [];
    while (!this.is(')')) {
      if (this.is('...')) {
        const d = this.advance();
        let inner = null;
        if (!this.is(')') && !this.is(',')) inner = this.parseType();
        items.push({ type: 'TypePack', inner: inner, loc: { line: d.line, column: d.column } });
      }
      else {
        let name = null;
        if (this.isType('Name') && this.peekToken().value === ':') { name = this.advance().value; this.advance(); }
        let ty = this.parseType();
        if (this.is('...')) { this.advance(); ty = { type: 'TypePack', inner: ty, loc: ty.loc }; }
        items.push({ type: 'TypeFunctionParam', name: name, annotation: ty, loc: ty.loc });
      }
      if (this.is(',')) { this.advance(); continue; }
      break;
    }
    return items;
  }

  parseType() { return this.parseTypeUnion(); }

  parseTypeUnion() {
    let left = this.parseTypeIntersection();
    while (this.is('|')) {
      const op = this.advance();
      left = node('TypeUnion', { left: left, right: this.parseTypeIntersection() }, op);
    }
    return left;
  }

  parseTypeIntersection() {
    let left = this.parseTypeSuffix();
    while (this.is('&')) {
      const op = this.advance();
      left = node('TypeIntersection', { left: left, right: this.parseTypeSuffix() }, op);
    }
    return left;
  }

  parseTypeSuffix() {
    let t = this.parseTypePrimary();
    while (this.is('?')) { const q = this.advance(); t = node('TypeOptional', { inner: t }, q); }
    return t;
  }

  parseTypePrimary() {
    const t = this.tok;
    if (t.type === 'String') { this.advance(); return node('TypeSingleton', { kind: 'string', value: t.value, raw: t.raw }, t); }
    if (t.value === 'true' || t.value === 'false') { this.advance(); return node('TypeSingleton', { kind: 'boolean', value: t.value === 'true' }, t); }
    if (t.type === 'Name' && t.value === 'typeof' && this.peekToken().value === '(') {
      const s = this.advance(); this.advance();
      const e = this.parseExpr();
      this.expect(')');
      return node('TypeofType', { expression: e }, s);
    }
    if (this.is('{')) return this.parseTypeTable();
    if (this.is('<')) {
      const generics = this.parseGenericTypeParams();
      this.expect('(');
      const params = this.parseTypeList();
      this.expect(')');
      this.expect('->');
      return node('TypeFunction', { generics: generics, params: params, returns: this.parseType() }, t);
    }
    if (this.is('(')) {
      this.advance();
      const items = this.parseTypeList();
      this.expect(')');
      if (this.is('->')) { this.advance(); return node('TypeFunction', { generics: null, params: items, returns: this.parseType() }, t); }
      return node('TypeTuple', { types: items }, t);
    }
    if (t.type === 'Name' || t.value === 'nil') {
      const parts = [this.advance().value];
      while (this.is('.')) { this.advance(); parts.push(this.expectName().value); }
      let generics = null;
      if (this.is('<')) generics = this.parseGenericTypeArgs();
      return node('TypeName', { path: parts, generics: generics }, t);
    }
    this.error("expected type but got '" + t.value + "'");
  }

  parseTypeTable() {
    const start = this.expect('{');
    const fields = [];
    while (!this.is('}')) {
      if (this.is('[')) {
        this.advance();
        const k = this.parseType();
        this.expect(']'); this.expect(':');
        let v = this.parseType();
        if (this.is('...')) { this.advance(); v = { type: 'TypePack', inner: v, loc: v.loc }; }
        fields.push(node('TypeTableIndexer', { key: k, value: v }, start));
      } else if (this.tok.type === 'Name' || KEYWORDS.has(this.tok.value)) {
        const nameTok = this.advance();
        let optional = false;
        if (this.is('?')) { this.advance(); optional = true; }
        this.expect(':');
        let v = this.parseType();
        if (this.is('...')) { this.advance(); v = { type: 'TypePack', inner: v, loc: v.loc }; }
        fields.push(node('TypeTableProperty', { key: nameTok.value, optional: optional, value: v }, nameTok));
      } else this.error("expected table type field but got '" + this.tok.value + "'");
      if (this.is(',') || this.is(';')) { this.advance(); continue; }
      break;
    }
    this.expect('}');
    return node('TypeTableType', { fields: fields }, start);
  }

  parseReturnType() {
    if (this.is('(')) {
      const t = this.advance();
      const items = this.parseTypeList();
      this.expect(')');
      if (this.is('->')) { this.advance(); return node('TypeFunction', { generics: null, params: items, returns: this.parseType() }, t); }
      return node('TypeTuple', { types: items }, t);
    }
    return this.parseType();
  }

  /* ================= Expressions ================= */

  parseExprList() {
    const list = [this.parseExpr()];
    while (this.is(',')) { this.advance(); list.push(this.parseExpr()); }
    return list;
  }

  parseExpr(limit) {
    limit = limit || 0;
    let left;
    if (UNARY_OPS.has(this.tok.value)) {
      const op = this.advance();
      left = node('UnaryExpression', { operator: op.value, argument: this.parseExpr(11) }, op);
    } else {
      left = this.parseSimpleExp();
    }
    for (;;) {
      const op = this.tok.value;
      const prio = BIN_PRIORITY[op];
      if (!prio || prio[0] <= limit) break;
      this.advance();
      left = node('BinaryExpression', { operator: op, left: left, right: this.parseExpr(prio[1]) }, left.loc ? this.tok : this.tok);
      left.loc = left.left ? left.left.loc : { line: 0, column: 0 };
    }
    return left;
  }

  parseSimpleExp() {
    const t = this.tok;
    if (t.type === 'Number') { this.advance(); return node('NumberLiteral', { value: t.value, raw: t.raw }, t); }
    if (t.type === 'String') { this.advance(); return node('StringLiteral', { value: t.value, raw: t.raw, long: !!t.long }, t); }
    if (t.type === 'InterpBegin') { this.advance(); return this.parseInterpString(t); }
    if (t.value === 'nil') { this.advance(); return node('NilLiteral', {}, t); }
    if (t.value === 'true' || t.value === 'false') { this.advance(); return node('BooleanLiteral', { value: t.value === 'true' }, t); }
    if (t.value === '...') { this.advance(); return node('VarargLiteral', {}, t); }
    if (t.value === '{') return this.parseTableConstructor();
    if (t.value === 'function') { const s = this.advance(); const body = this.parseFunctionBody(); return node('FunctionExpression', { generics: body.generics, params: body.params, returnType: body.returnType, body: body.body }, s); }
    if (t.type === 'Name' || t.value === '(') {
      let e = this.parseSuffixedExp();
      while (this.is('::')) { const c = this.advance(); e = node('TypeCastExpression', { expression: e, typeAnnotation: this.parseType() }, c); }
      return e;
    }
    this.error("unexpected symbol '" + t.value + "'");
  }

  parseInterpString(startTok) {
    const parts = [];
    for (;;) {
      if (this.isType('InterpPart')) { const t = this.advance(); parts.push({ kind: 'string', value: t.value, raw: t.raw }); continue; }
      if (this.isType('InterpExprBegin')) { this.advance(); const e = this.parseExpr(); if (!this.isType('InterpExprEnd')) this.error("expected '}' to close interpolation"); this.advance(); parts.push({ kind: 'expr', expression: e }); continue; }
      if (this.isType('InterpEnd')) { this.advance(); break; }
      this.error('malformed interpolated string');
    }
    return node('InterpolatedString', { parts: parts }, startTok);
  }

  parseTableConstructor() {
    const start = this.expect('{');
    const fields = [];
    while (!this.is('}')) {
      if (this.is('[')) {
        this.advance();
        const k = this.parseExpr();
        this.expect(']'); this.expect('=');
        fields.push(node('TableKey', { key: k, value: this.parseExpr() }, start));
      } else if (this.tok.type === 'Name' && this.peekToken().value === '=') {
        const k = this.advance();
        this.expect('=');
        fields.push(node('TableField', { key: id(k), value: this.parseExpr() }, k));
      } else {
        fields.push(node('TableValue', { value: this.parseExpr() }, this.tok));
      }
      if (this.is(',') || this.is(';')) { this.advance(); continue; }
      break;
    }
    this.expect('}');
    return node('TableConstructor', { fields: fields }, start);
  }

  parsePrimaryExp() {
    const t = this.tok;
    if (t.type === 'Name') { this.advance(); return id(t); }
    if (t.value === '(') {
      this.advance();
      const e = this.parseExpr();
      this.expect(')');
      return node('ParenExpression', { expression: e }, t);
    }
    this.error("unexpected symbol '" + t.value + "'");
  }

  parseCallArgs() {
    if (this.is('(')) {
      this.advance();
      const args = [];
      if (!this.is(')')) {
        args.push(this.parseExpr());
        while (this.is(',')) { this.advance(); if (this.is(')')) break; args.push(this.parseExpr()); }
      }
      this.expect(')');
      return args;
    }
    if (this.is('{')) return [this.parseTableConstructor()];
    if (this.isType('String')) { const t = this.advance(); return [node('StringLiteral', { value: t.value, raw: t.raw, long: !!t.long }, t)]; }
    if (this.isType('InterpBegin')) { const t = this.advance(); return [this.parseInterpString(t)]; }
    this.error('expected function call arguments');
  }

  parseSuffixedExp() {
    let base = this.parsePrimaryExp();
    for (;;) {
      if (this.is('.')) {
        this.advance();
        base = node('MemberExpression', { object: base, property: id(this.expectName()), computed: false }, base.loc);
      } else if (this.is('[')) {
        this.advance();
        const i = this.parseExpr();
        this.expect(']');
        base = node('IndexExpression', { object: base, index: i }, base.loc);
      } else if (this.is(':')) {
        this.advance();
        const m = this.expectName();
        const args = this.parseCallArgs();
        base = node('CallExpression', {
          callee: node('MemberExpression', { object: base, property: id(m), computed: false }, base.loc),
          arguments: args, method: true, typeArguments: null
        }, base.loc);
      } else if (this.is('(') || this.is('{') || this.isType('String') || this.isType('InterpBegin')) {
        base = node('CallExpression', { callee: base, arguments: this.parseCallArgs(), method: false, typeArguments: null }, base.loc);
      } else if (this.is('<')) {
        // kemungkinan panggilan generic eksplisit: f<T, U>(args)
        const m = this.mark();
        let ok = false, typeArgs = null;
        try { typeArgs = this.parseGenericTypeArgs(); ok = this.is('(') || this.is('{') || this.isType('String') || this.isType('InterpBegin'); } catch (_) { ok = false; }
        if (ok) {
          base = node('CallExpression', { callee: base, arguments: this.parseCallArgs(), method: false, typeArguments: typeArgs }, base.loc);
          continue;
        }
        this.restore(m);
        break;
      } else break;
    }
    return base;
  }
}

/* ============================ Public API ============================ */

function parse(source, options) {
  return new Parser(source, options).parseChunk();
}

function tokenize(source, options) {
  const l = new Lexer(source);
  const out = [];
  let t;
  do { t = l.next(options && options.captureComments); out.push(t); } while (t.type !== 'EOF');
  return out;
}

const API = { parse: parse, tokenize: tokenize, LuauSyntaxError: LuauSyntaxError, KEYWORDS: KEYWORDS, Lexer: Lexer, Parser: Parser };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof globalThis !== 'undefined') globalThis.LuauParser = API;
