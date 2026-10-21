const P = require('./luau_parser.js');

const sample = `#! /usr/bin/env lune
--!strict
-- contoh kompleks untuk parser
--[[ komentar
   panjang ]]

@native
local function fib(n: number): number
    if n < 2 then return n end
    return fib(n - 1) + fib(n - 2)
end

export type Result<T, E...> = { ok: true, value: T } | { ok: false, err: string }
type Callback = (player: Player, ...any) -> (boolean, string?)

local t: { [string]: number } = { [1] = "satu", nama = "andi", 10; 20, }
t.x += 1
t.field ..= "?"

for i = 1, 10, 2 do
    print(\`iter {i} dan {fib(i)} -> { {1, 2} }\`)
end

for k, v in pairs(t) do
    if k == "nama" then continue end
end

repeat
    local r = math.random()
until r > 0.5

while true do break end

local s = \`halo {"dunia"} {1 + 2}!\`
local fn = function<T>(x: T, ...: any): (T, number)
    return x, 1
end
local g = fn<number>(42)
local casted = (x :: any) + 1
local wut = y :: <T>(T) -> T

local mt = setmetatable({}, { __index = function(self, k) return rawget(self, k) end })
local str = ("x"):rep(3)
print "hello" {1} [[world]]

do
    local a, b = 1, 2
    a, b = b, a
    local hex, bin, us = 0xFF, 0b1010, 1_000_000
    local esc = "a\\nb\\x41\\u{1F600}\\z
        lanjut"
end
`;

const ast = P.parse(sample, { captureComments: true });
console.log('PARSE OK — statements:', ast.body.length);

// ringkasan tipe node (rekursif)
const counts = {};
(function walk(n) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { n.forEach(walk); return; }
  if (n.type) counts[n.type] = (counts[n.type] || 0) + 1;
  for (const k in n) if (k !== 'loc' && k !== 'leadingComments') walk(n[k]);
})(ast);
console.log('Node types:', JSON.stringify(counts, null, 1));

// --- uji per-fitur ---
function ok(name, src) {
  try { P.parse(src); console.log('PASS', name); }
  catch (e) { console.log('FAIL', name, '--', e.message); }
}
function bad(name, src) {
  try { P.parse(src); console.log('FAIL (harusnya error)', name); }
  catch (e) { console.log('PASS', name, '(error terdeteksi:', e.message.slice(0, 40) + '...)'); }
}

ok('string interp bersarang', 'local s = `a {`b {1}`} c`');
ok('table call sugar', 'f{1,2} g"h" h[[x]]');
ok('method + index', 'local x = a.b.c[1]:method(2).d');
ok('generic call eksplisit', 'local x = f<number, string>(1)');
ok('perbandingan biasa tetap jalan', 'if a < b and c > d then end');
ok('label-less compound', 'x += 1');
ok('method function decl', 'function a.b.c:m(x) return self end');
ok('attributes', '@checked @deprecated("jangan dipakai") function f() end');
ok('type alias kompleks', 'type X<T...> = { a: number?, [string]: T... } & (typeof(game))');
ok('tuple return', 'local f = function(): (number, string) return 1, "a" end');
ok('shebang', '#!/usr/bin/env lune\nlocal x = 1');
ok('vararg', 'local function f(...: any) return ... end');
ok('do/repeat/until', 'repeat do break end until x');
ok('elseif chain', 'if a then elseif b then elseif c then else end');
ok('comment capture', '-- hi\nlocal x = 1');
ok('long string lvl', 'local s = [==[ ada ]] di dalam ]==]');

bad('error: end hilang', 'if x then');
bad('error: ) hilang', 'local f = function(a, b return end');
bad('error: string tak selesai', 'local s = "abc');
bad('error: interp tak selesai', 'local s = `abc {1}');
bad('error: statement aneh', '1 + 2');
bad('error: tipe ngawur', 'local x: 5 = 1');

// tokenize demo
const toks = P.tokenize('local x = 1');
console.log('tokenize:', toks.map(t => t.type + ':' + t.value).join('  '));
