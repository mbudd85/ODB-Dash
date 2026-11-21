// Safe formula evaluator, same rules as obd/formula.py.
// "(A*256+B)/4", "signed(A)-40", "signed16(A*256+B)/16". No eval().
"use strict";

const OBDFormula = (() => {
  const FUNCS = {
    signed: (x) => { x = Math.trunc(x); return x & 0x80 ? x - 256 : x; },
    signed16: (x) => { x = Math.trunc(x); return x & 0x8000 ? x - 65536 : x; },
    abs: Math.abs, min: Math.min, max: Math.max, round: Math.round,
  };
  const LETTERS = "ABCDEFGH";

  function tokenize(src) {
    const re = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)|([A-Za-z_]\w*)|(\*\*|\/\/|<<|>>|[-+*/%&|^~(),]))/gy;
    const out = [];
    let m;
    re.lastIndex = 0;
    while (re.lastIndex < src.length) {
      const start = re.lastIndex;
      m = re.exec(src);
      if (!m) {
        if (/^\s*$/.test(src.slice(start))) break;
        throw new Error(`can't read formula near "${src.slice(start, start + 8)}"`);
      }
      if (m[1] !== undefined) out.push({ t: "num", v: parseFloat(m[1]) });
      else if (m[2] !== undefined) out.push({ t: "name", v: m[2] });
      else out.push({ t: "op", v: m[3] });
    }
    return out;
  }

  // Python-like precedence (low -> high)
  const BIN = { "|": 1, "^": 2, "&": 3, "<<": 4, ">>": 4, "+": 5, "-": 5, "*": 6, "/": 6, "//": 6, "%": 6 };
  const OPS = {
    "|": (a, b) => a | b, "^": (a, b) => a ^ b, "&": (a, b) => a & b,
    "<<": (a, b) => a << b, ">>": (a, b) => a >> b, "+": (a, b) => a + b, "-": (a, b) => a - b,
    "*": (a, b) => a * b, "/": (a, b) => a / b, "//": (a, b) => Math.floor(a / b),
    "%": (a, b) => ((a % b) + b) % b, "**": (a, b) => a ** b,
  };

  function compile(src) {
    const toks = tokenize(String(src).trim());
    let i = 0, needed = 0;
    const peek = () => toks[i];
    const take = (v) => {
      const t = toks[i];
      if (!t || (v && t.v !== v)) throw new Error(v ? `expected "${v}"` : "formula ends too early");
      i++;
      return t;
    };

    function primary() {
      const t = take();
      if (t.t === "num") return () => t.v;
      if (t.t === "name") {
        if (LETTERS.includes(t.v) && t.v.length === 1) {
          const k = LETTERS.indexOf(t.v);
          needed = Math.max(needed, k + 1);
          return (env) => env[k];
        }
        const f = FUNCS[t.v];
        if (!f) throw new Error(`unknown name '${t.v}' (use A–H for bytes)`);
        take("(");
        const args = [];
        if (peek()?.v !== ")") {
          args.push(expr(0));
          while (peek()?.v === ",") { take(","); args.push(expr(0)); }
        }
        take(")");
        return (env) => f(...args.map((a) => a(env)));
      }
      if (t.v === "(") { const e = expr(0); take(")"); return e; }
      throw new Error(`unexpected "${t.v}"`);
    }

    function power() {           // ** binds tighter than unary minus on its left, right-assoc
      const base = primary();
      if (peek()?.v === "**") { take("**"); const exp = unary(); return (env) => base(env) ** exp(env); }
      return base;
    }

    function unary() {
      const t = peek();
      if (t?.t === "op" && (t.v === "-" || t.v === "+" || t.v === "~")) {
        take();
        const e = unary();
        return t.v === "-" ? (env) => -e(env) : t.v === "~" ? (env) => ~e(env) : e;
      }
      return power();
    }

    function expr(minPrec) {
      let left = unary();
      for (;;) {
        const t = peek();
        if (!t || t.t !== "op" || !(t.v in BIN) || BIN[t.v] < minPrec) break;
        take();
        const right = expr(BIN[t.v] + 1);
        const op = OPS[t.v], l = left;
        left = (env) => op(l(env), right(env));
      }
      return left;
    }

    if (!toks.length) throw new Error("formula is empty");
    const fn = expr(0);
    if (i < toks.length) throw new Error(`unexpected "${toks[i].v}"`);
    const run = (bytes) => fn(bytes);
    run.nbytes = needed;
    return run;
  }

  return { compile };
})();
