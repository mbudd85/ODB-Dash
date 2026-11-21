"""Safe evaluator for sensor formulas like "(A*256+B)/4" or "signed(A)-40".

A, B, C ... are the data bytes of the reply. Only arithmetic, bit operations
and a few helper functions are allowed, so user-entered formulas can't run code.
"""

import ast
import operator

_BIN = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod,
    ast.Pow: operator.pow, ast.BitAnd: operator.and_, ast.BitOr: operator.or_,
    ast.BitXor: operator.xor, ast.LShift: operator.lshift, ast.RShift: operator.rshift,
}
_UN = {ast.USub: operator.neg, ast.UAdd: operator.pos, ast.Invert: operator.invert}


def _signed(x, bits=8):
    x = int(x)
    return x - (1 << bits) if x & (1 << (bits - 1)) else x


_FUNCS = {
    "signed": _signed,                      # signed(A) -> -128..127
    "signed16": lambda x: _signed(x, 16),   # signed16(A*256+B)
    "abs": abs, "min": min, "max": max, "round": round,
}
LETTERS = "ABCDEFGH"


class FormulaError(ValueError):
    pass


def compile_formula(expr: str):
    """Validate once; returns a function bytes -> float."""
    try:
        tree = ast.parse(expr.strip(), mode="eval")
    except SyntaxError as e:
        raise FormulaError(f"can't read formula: {e.msg}") from None
    needed = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            if node.id in LETTERS:
                needed = max(needed, LETTERS.index(node.id) + 1)
            elif node.id not in _FUNCS:
                raise FormulaError(f"unknown name '{node.id}' (use A–H for bytes)")
        elif isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in _FUNCS:
                raise FormulaError("only signed(), signed16(), abs(), min(), max(), round() are allowed")
        elif not isinstance(node, (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant, ast.Load,
                                   *(_BIN.keys()), *(_UN.keys()))):
            raise FormulaError(f"'{type(node).__name__}' isn't allowed in a formula")
        if isinstance(node, ast.Constant) and not isinstance(node.value, (int, float)):
            raise FormulaError("only numbers are allowed")

    def ev(node, env):
        if isinstance(node, ast.Expression):
            return ev(node.body, env)
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            return env[node.id] if node.id in env else _FUNCS[node.id]
        if isinstance(node, ast.BinOp):
            return _BIN[type(node.op)](ev(node.left, env), ev(node.right, env))
        if isinstance(node, ast.UnaryOp):
            return _UN[type(node.op)](ev(node.operand, env))
        if isinstance(node, ast.Call):
            return _FUNCS[node.func.id](*[ev(a, env) for a in node.args])
        raise FormulaError("bad formula")

    def run(data: list[int]) -> float:
        env = {LETTERS[i]: b for i, b in enumerate(data[:8])}
        return float(ev(tree, env))

    run.nbytes = needed
    return run
