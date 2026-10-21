// ============================================================
// LUAU LEXER — JavaScript (kompatibel Delta Executor / Node.js)
// Komponen untuk Luau Obfuscator
// Fitur: seluruh keyword Luau, operator compound, long string,
//        string interpolation (backtick), angka hex/bin/desimal,
//        comment, shebang, error recovery, posisi token (line/col)
// ============================================================

const TokenType = Object.freeze({
    EOF: 'EOF',
    IDENTIFIER: 'Identifier',
    KEYWORD: 'Keyword',
    NUMBER: 'Number',
    STRING: 'String',
    LONG_STRING: 'LongString',
    INTERP_STRING: 'InterpolatedString',   // node pembungkus
    INTERP_TEXT: 'InterpText',             // potongan teks polos
    INTERP_EXPR_START: 'InterpExprStart',  // '{'
    INTERP_EXPR_END: 'InterpExprEnd',      // '}'
    OPERATOR: 'Operator',
    PUNCTUATION: 'Punctuation',
    COMMENT: 'Comment',
    WHITESPACE: 'Whitespace',
    SHEBANG: 'Shebang',
    ERROR: 'Error'
});

const KEYWORDS = new Set([
    'and', 'break', 'continue', 'do', 'else', 'elseif', 'end', 'false',
    'for', 'function', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat',
    'return', 'then', 'true', 'until', 'while',
    // Luau-specific
    'type', 'export'
]);

// Diurutkan dari terpanjang agar greedy matching benar
const OPERATORS = [
    '...', '..=', '//=', '==', '~=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '^=', '..', '//',
    '+', '-', '*', '/', '%', '^', '#', '<', '>', '=', '(', ')', '{', '}', '[', ']', ';', ':', ',', '.', '?'
];

const PUNCT_CHARS = new Set('(){}[];:,.');

class LexError extends Error {
    constructor(message, line, column, index) {
        super(`${message} (line ${line}, col ${column})`);
        this.name = 'LexError';
        this.line = line;
        this.column = column;
        this.index = index;
    }
}

class Token {
    constructor(type, value, line, column, index, extra) {
        this.type = type;
        this.value = value;
        this.line = line;
        this.column = column;
        this.index = index;
        if (extra) Object.assign(this, extra);
    }
    toString() {
        const v = typeof this.value === 'string' && this.value.length > 40
            ? this.value.slice(0, 40) + '...' : this.value;
        return `${this.type}(${JSON.stringify(v)}) @${this.line}:${this.column}`;
    }
}

class Lexer {
    constructor(source, options = {}) {
        if (typeof source !== 'string') throw new TypeError('Source harus string');
        this.src = source;
        this.pos = 0;
        this.line = 1;
        this.col = 1;
        this.length = source.length;
        // Opsi
        this.keepComments = options.keepComments !== false;   // default simpan
        this.keepWhitespace = !!options.keepWhitespace;       // default skip
        this.strict = !!options.strict;                       // lempar error vs recovery
        this.errors = [];                                     // error recovery log
    }

    // ---------- utility ----------
    peek(offset = 0) {
        return this.src[this.pos + offset];
    }
    isAtEnd() {
        return this.pos >= this.length;
    }
    advance() {
        const c = this.src[this.pos++];
        if (c === '\n') { this.line++; this.col = 1; }
        else this.col++;
        return c;
    }
    match(c) {
        if (this.peek() === c) { this.advance(); return true; }
        return false;
    }
    error(msg) {
        const e = new LexError(msg, this.line, this.col, this.pos);
        if (this.strict) throw e;
        this.errors.push(e);
    }

    // ---------- entry point ----------
    tokenize() {
        const tokens = [];
        // shebang opsional di awal file
        if (this.src.startsWith('#!')) {
            const startLine = this.line, startCol = this.col, startPos = this.pos;
            let text = '';
            while (!this.isAtEnd() && this.peek() !== '\n') text += this.advance();
            tokens.push(new Token(TokenType.SHEBANG, text, startLine, startCol, startPos));
        }
        while (!this.isAtEnd()) {
            const c = this.peek();
            if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v') {
                const t = this.lexWhitespace();
                if (this.keepWhitespace) tokens.push(t);
            } else if (c === '-' && this.peek(1) === '-') {
                const t = this.lexComment();
                if (this.keepComments) tokens.push(t);
            } else if (c === '"' || c === "'") {
                tokens.push(this.lexShortString(c));
            } else if (c === '`') {
                tokens.push(this.lexInterpString());
            } else if (c === '[' && (this.peek(1) === '[' || this.peek(1) === '=')) {
                const t = this.tryLongString();
                if (t) tokens.push(t);
                else tokens.push(this.lexOperatorOrPunct());
            } else if (this.isDigit(c) || (c === '.' && this.isDigit(this.peek(1)))) {
                tokens.push(this.lexNumber());
            } else if (this.isIdentStart(c)) {
                tokens.push(this.lexIdentifier());
            } else {
                tokens.push(this.lexOperatorOrPunct());
            }
        }
        tokens.push(new Token(TokenType.EOF, '<eof>', this.line, this.col, this.pos));
        return tokens;
    }

    // ---------- whitespace ----------
    lexWhitespace() {
        const sl = this.line, sc = this.col, sp = this.pos;
        let text = '';
        while (!this.isAtEnd()) {
            const c = this.peek();
            if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v') text += this.advance();
            else break;
        }
        return new Token(TokenType.WHITESPACE, text, sl, sc, sp);
    }

    // ---------- comments ----------
    lexComment() {
        const sl = this.line, sc = this.col, sp = this.pos;
        this.advance(); this.advance(); // '--'
        // long comment --[[ ... ]] atau --[==[ ... ]==]
        if (this.peek() === '[') {
            const saved = { pos: this.pos, line: this.line, col: this.col };
            const eq = this.countBracketEquals();
            if (eq !== null) {
                const content = this.readLongBracketContent(eq);
                if (content !== null) {
                    return new Token(TokenType.COMMENT, '--' + '[' + '='.repeat(eq) + '[' + content,
                        sl, sc, sp, { long: true });
                }
            }
            Object.assign(this, saved);
        }
        let text = '--';
        while (!this.isAtEnd() && this.peek() !== '\n') text += this.advance();
        return new Token(TokenType.COMMENT, text, sl, sc, sp, { long: false });
    }

    countBracketEquals() {
        // posisi di '['; kembalikan jumlah '=' atau null jika bukan long bracket
        if (this.peek() !== '[') return null;
        let i = this.pos + 1, eq = 0;
        while (this.src[i] === '=') { eq++; i++; }
        return this.src[i] === '[' ? eq : null;
    }

    readLongBracketContent(eq) {
        // konsumsi pembuka [=*[ lalu baca sampai ]=*]
        this.advance(); // [
        for (let i = 0; i < eq; i++) this.advance();
        this.advance(); // [
        const buf = [];
        while (!this.isAtEnd()) {
            if (this.peek() === ']' && this.peek(1) === '='.repeat(eq) ? false : false) { /* noop */ }
            if (this.peek() === ']') {
                let i = 1;
                while (this.src[this.pos + i] === '=') i++;
                const eqCount = i - 1;
                if (eqCount === eq && this.src[this.pos + i] === ']') {
                    const content = buf.join('');
                    for (let k = 0; k < i + 1; k++) this.advance();
                    return content;
                }
            }
            buf.push(this.advance());
        }
        this.error('Long bracket tidak ditutup');
        return buf.join('');
    }

    tryLongString() {
        const saved = { pos: this.pos, line: this.line, col: this.col };
        const eq = this.countBracketEquals();
        if (eq === null) return null;
        const sl = this.line, sc = this.col, sp = this.pos;
        const content = this.readLongBracketContent(eq);
        if (content === null) { Object.assign(this, saved); return null; }
        return new Token(TokenType.LONG_STRING, content, sl, sc, sp, { level: eq });
    }

    // ---------- short string ----------
    lexShortString(quote) {
        const sl = this.line, sc = this.col, sp = this.pos;
        this.advance(); // buka quote
        let value = '';
        while (true) {
            if (this.isAtEnd()) { this.error('String tidak ditutup'); break; }
            const c = this.peek();
            if (c === '\n') { this.error('Newline mentah di dalam string'); break; }
            if (c === quote) { this.advance(); break; }
            if (c === '\\') {
                this.advance();
                value += this.readEscape(quote);
            } else {
                value += this.advance();
            }
        }
        return new Token(TokenType.STRING, value, sl, sc, sp, { quote });
    }

    readEscape(quote) {
        if (this.isAtEnd()) { this.error('Escape terpotong'); return ''; }
        const c = this.advance();
        switch (c) {
            case 'a': return '\x07';
            case 'b': return '\b';
            case 'f': return '\f';
            case 'n': return '\n';
            case 'r': return '\r';
            case 't': return '\t';
            case 'v': return '\v';
            case '\\': return '\\';
            case '"': return '"';
            case "'": return "'";
            case '`': return '`';     // penting untuk obfuscator string interp
            case '\n': return '\n';   // line continuation
            case 'z': {
                // \z : skip semua whitespace berikutnya
                while (!this.isAtEnd() && /[ \t\r\n\f\v]/.test(this.peek())) this.advance();
                return '';
            }
            case 'x': {
                let h = '';
                for (let i = 0; i < 2 && /[0-9a-fA-F]/.test(this.peek() || ''); i++) h += this.advance();
                if (h.length !== 2) this.error('Escape \\x butuh 2 digit hex');
                return String.fromCharCode(parseInt(h || '0', 16));
            }
            case 'u': {
                if (this.peek() === '{') {
                    this.advance();
                    let h = '';
                    while (!this.isAtEnd() && this.peek() !== '}') h += this.advance();
                    this.match('}');
                    const cp = parseInt(h, 16);
                    if (isNaN(cp)) { this.error('Escape \\u{...} invalid'); return ''; }
                    return String.fromCodePoint(cp);
                }
                let h = '';
                for (let i = 0; i < 4 && /[0-9a-fA-F]/.test(this.peek() || ''); i++) h += this.advance();
                return String.fromCharCode(parseInt(h || '0', 16));
            }
            case '0': case '1': case '2': case '3':
            case '4': case '5': case '6': case '7': case '8': case '9': {
                let d = c;
                for (let i = 0; i < 2 && /[0-9]/.test(this.peek() || ''); i++) d += this.advance();
                const n = parseInt(d, 10);
                if (n > 255) this.error('Escape desimal > 255');
                return String.fromCharCode(n & 0xff);
            }
            default:
                // karakter tak dikenal setelah backslash — Luau: literal
                return c;
        }
    }

    // ---------- interpolated string (Luau) ----------
    lexInterpString() {
        const sl = this.line, sc = this.col, sp = this.pos;
        const parts = [];
        let text = '';
        this.advance(); // `
        while (true) {
            if (this.isAtEnd()) { this.error('Interpolated string tidak ditutup'); break; }
            const c = this.peek();
            if (c === '`') { this.advance(); break; }
            if (c === '\\') {
                this.advance();
                text += this.readEscape('`');
                continue;
            }
            if (c === '{') {
                if (text) {
                    parts.push(new Token(TokenType.INTERP_TEXT, text, sl, sc, sp));
                    text = '';
                }
                const es = new Token(TokenType.INTERP_EXPR_START, '{', this.line, this.col, this.pos);
                parts.push(es);
                this.advance();
                // lex ekspresi di dalam {} secara rekursif sampai '}' selevel
                parts.push(...this.lexInterpExpr());
                if (this.peek() === '}') {
                    parts.push(new Token(TokenType.INTERP_EXPR_END, '}', this.line, this.col, this.pos));
                    this.advance();
                } else {
                    this.error('Interp expr tidak ditutup }');
                }
                continue;
            }
            text += this.advance();
        }
        if (text) parts.push(new Token(TokenType.INTERP_TEXT, text, sl, sc, sp));
        return new Token(TokenType.INTERP_STRING, null, sl, sc, sp, { parts });
    }

    lexInterpExpr() {
        // tokenkan ekspresi dalam {} dengan brace-matching & string-aware
        const out = [];
        let depth = 1;
        while (!this.isAtEnd() && depth > 0) {
            const c = this.peek();
            if (c === '"' || c === "'") { out.push(this.lexShortString(c)); continue; }
            if (c === '`') { out.push(this.lexInterpString()); continue; }
            if (c === '{' && this.peek(1) === '[') {
                const t = this.tryLongString();
                if (t) { out.push(t); continue; }
            }
            if (c === '-' && this.peek(1) === '-') { this.lexComment(); continue; } // skip comment dlm expr
            if (c === '{') { depth++; out.push(new Token(TokenType.PUNCTUATION, '{', this.line, this.col, this.pos)); this.advance(); continue; }
            if (c === '}') {
                depth--;
                if (depth === 0) break;
                out.push(new Token(TokenType.PUNCTUATION, '}', this.line, this.col, this.pos));
                this.advance(); continue;
            }
            if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { this.advance(); continue; }
            if (this.isDigit(c)) { out.push(this.lexNumber()); continue; }
            if (this.isIdentStart(c)) { out.push(this.lexIdentifier()); continue; }
            out.push(this.lexOperatorOrPunct());
        }
        // kembalikan posisi di '}' penutup selevel
        return out;
    }

    // ---------- number ----------
    lexNumber() {
        const sl = this.line, sc = this.col, sp = this.pos;
        let raw = '';
        let radix = 10;
        if (this.peek() === '0' && /[xX]/.test(this.peek(1) || '')) {
            raw += this.advance() + this.advance();
            radix = 16;
            while (/[0-9a-fA-F]/.test(this.peek() || '')) raw += this.advance();
        } else if (this.peek() === '0' && /[bB]/.test(this.peek(1) || '')) {
            raw += this.advance() + this.advance();
            radix = 2;
            while (/[01]/.test(this.peek() || '')) raw += this.advance();
        } else {
            while (this.isDigit(this.peek())) raw += this.advance();
            if (this.peek() === '.' && this.isDigit(this.peek(1))) {
                raw += this.advance();
                while (this.isDigit(this.peek())) raw += this.advance();
            }
            if (/[eE]/.test(this.peek() || '')) {
                let e = this.advance();
                if (/[+-]/.test(this.peek() || '')) e += this.advance();
                if (!this.isDigit(this.peek())) { this.error('Exponent butuh digit'); }
                else while (this.isDigit(this.peek())) e += this.advance();
                raw += e;
            }
        }
        // suffix? Luau tidak punya; cek pemisah ilegal seperti 123abc
        if (this.isIdentStart(this.peek())) {
            this.error(`Karakter tidak valid setelah angka: '${this.peek()}'`);
        }
        const value = radix === 10 ? parseFloat(raw) : parseInt(raw.slice(2), radix);
        return new Token(TokenType.NUMBER, raw, sl, sc, sp, { numericValue: value, radix });
    }

    // ---------- identifier / keyword ----------
    lexIdentifier() {
        const sl = this.line, sc = this.col, sp = this.pos;
        let name = '';
        while (!this.isAtEnd() && this.isIdentPart(this.peek())) name += this.advance();
        const type = KEYWORDS.has(name) ? TokenType.KEYWORD : TokenType.IDENTIFIER;
        return new Token(type, name, sl, sc, sp);
    }

    // ---------- operator / punctuation ----------
    lexOperatorOrPunct() {
        const sl = this.line, sc = this.col, sp = this.pos;
        for (const op of OPERATORS) {
            if (this.src.startsWith(op, this.pos)) {
                // '.' vs '..' vs '...' sudah dihandle urutan; tapi '.' sendiri = PUNCT
                for (let i = 0; i < op.length; i++) this.advance();
                const isPunct = PUNCT_CHARS.has(op) && !'...'.includes(op) ? true
                    : (op.length === 1 && PUNCT_CHARS.has(op));
                return new Token(isPunct ? TokenType.PUNCTUATION : TokenType.OPERATOR, op, sl, sc, sp);
            }
        }
        const bad = this.advance();
        this.error(`Karakter tidak dikenal: '${bad}'`);
        return new Token(TokenType.ERROR, bad, sl, sc, sp);
    }

    // ---------- char classes ----------
    isDigit(c) { return c >= '0' && c <= '9'; }
    isIdentStart(c) { return /[A-Za-z_]/.test(c || ''); }
    isIdentPart(c) { return /[A-Za-z0-9_]/.test(c || ''); }
}

// ============================================================
// API helpers
// ============================================================

function lex(source, options) {
    const lx = new Lexer(source, options);
    return { tokens: lx.tokenize(), errors: lx.errors };
}

// Hanya token bermakna (buang whitespace & comment) — biasa dipakai obfuscator
function lexSignificant(source, options = {}) {
    const { tokens, errors } = lex(source, { ...options, keepWhitespace: false, keepComments: false });
    return { tokens: tokens.filter(t => t.type !== TokenType.WHITESPACE && t.type !== TokenType.COMMENT), errors };
}

// Contoh / self-test
if (typeof process !== 'undefined' && process.argv && process.argv[1] &&
    /lexer\.js$/.test(process.argv[1])) {
    const demo = `#!/usr/bin/env luau
-- contoh komentar & long comment
--[[ long
   comment ]]
local x: number = 0xFF + 2e3 // 4 ..= 'it\\'s'
local s = \`halo {name .. "!"} \\u{1F600} { {1,2} }\`
local b = [==[ multi
line ]==]
for i = 1, 10 do continue end
`;
    const { tokens, errors } = lexSignificant(demo);
    for (const t of tokens) console.log(t.toString());
    if (errors.length) console.log('ERRORS:', errors.map(e => e.message));
}

// Ekspor (Delta executor: global; Node: module)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Lexer, Token, TokenType, lex, lexSignificant, LexError };
}
if (typeof globalThis !== 'undefined') {
    globalThis.Lexer = Lexer;
    globalThis.LexerTokenType = TokenType;
    globalThis.lexLuau = lex;
    globalThis.lexLuauSignificant = lexSignificant;
}
