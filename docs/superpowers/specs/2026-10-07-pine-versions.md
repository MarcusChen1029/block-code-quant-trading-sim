# Pine v4 / v6 support — design note (2026-10-07)

Extends the v5-subset compiler (spec 2026-10-05 §6) to `//@version=4` and `//@version=6`. One lexer, parser,
analysis, codegen and runtime. Version differences live in `src/pine/v4.ts` (v4 -> v5 AST normaliser),
`src/pine/v6.ts` (v6 type rules) and a few flags in `src/pine/dialect.ts`.

Sources (fetched 2026-10-07; keys used below):
- [M5] https://www.tradingview.com/pine-script-docs/migration-guides/to-pine-version-5/
- [M6] https://www.tradingview.com/pine-script-docs/migration-guides/to-pine-version-6/
- [M4] https://www.tradingview.com/pine-script-docs/migration-guides/to-pine-version-4/ (v3 -> v4)
- [R4] https://www.tradingview.com/pine-script-reference/v4/
- [T4] https://www.tradingview.com/pine-script-docs/v4/language/type-system/
- [O4] https://www.tradingview.com/pine-script-docs/v4/language/operators/
- [S4] https://www.tradingview.com/pine-script-docs/v4/language/expressions-declarations-and-statements/
- [RN4] https://www.tradingview.com/pine-script-docs/v4/release-notes/
- [R5] https://www.tradingview.com/pine-script-reference/v5/ , [R6] https://www.tradingview.com/pine-script-reference/v6/
- [TS6] https://www.tradingview.com/pine-script-docs/language/type-system/ (fetched 2026-10-08)
- [SO] https://stackoverflow.com/questions/72829101/constant-division-by-zero-error-in-pine-script (community, NOT
  official; fetched 2026-10-08)

## Version line
`//@version=4|5|6` selects the dialect. Missing line: warning, compiled as v5 (unchanged rule). 1..3, above 6,
or no leading number (`//@version=abc`): error on that line. Leading digits with trailing text (`5.0`) compiled
as that number before; the docs only show plain numbers (unverified), so it stays accepted, with a warning.

## (a) v4 differences that touch our subset -> normalised to the v5 AST
- Namespaces [M5 rename tables]: bare `sma ema rma wma rsi stdev change highest lowest macd bb atr stoch
  crossover crossunder tr()` -> `ta.*`; bare `abs sqrt log log10 exp floor ceil sign sin cos tan asin acos atan
  todegrees toradians pow round max min avg` -> `math.*`. Only calls are rewritten, and never when the script
  defines a function of that name.
- `tr` is a built-in variable in v4, "same as tr(false)" [R4]; v5 `ta.tr` [M5] -> rewritten unless the script
  declares a variable `tr`.
- Signatures unchanged by the rename: `stoch(source, high, low, length)`, one-argument `highest(length)` /
  `lowest(length)`, `change` default length 1, `macd` / `bb` tuples [R4, M5]. v4's second `rsi(x, y)` overload
  (y a series) was removed in v5 [M5]; we keep "length must be a constant", so it is a compile error.
- `study(title, shorttitle, overlay, format, precision, scale, max_bars_back, max_lines_count,
  max_labels_count, resolution, resolution_gaps, max_boxes_count, explicit_plot_zorder)` [R4] -> `indicator()`
  with named arguments (the positional order differs after `max_bars_back`).
- `input()` has one overload per type in [R4], and the positional order differs after `type`:
  - integer / float: `input(defval, title, type, minval, maxval, confirm, step, options, tooltip, inline, group)`
  - bool: `input(defval, title, type, confirm, tooltip, inline, group)` (so `input(true, "B", input.bool, true)` passes
    `confirm`; it was wrongly bound as `minval` before 2026-10-08)
  - source (series overload): `input(defval, title, type, inline, group, tooltip)`

  The type comes from `type=` / the 3rd positional, else from the default; the call is then bound with that
  type's overload. A named argument that only another overload has (`minval` on a bool) is an error. The input
  becomes `input.int|float|bool|source(...)` [M5]. Without `type`, int/float/bool come from the default [T4]. The doc does not say whether a source default works without
  `type` (unverified), so we accept it with a warning.
- `iff(cond, then, else)` was removed in v5 [M5]. It always evaluates both branches [M5, RN4], so it compiles to an
  eager runtime call, not to `?:`. Its condition is false for 0, na and infinity: [R4] `iff` says "Zero value (0 and
  also NaN, +Infinity, -Infinity) is considered to be false" (verified 2026-10-08).
- `plot(series, title, color, linewidth, style, trackprice, transp, histbase, offset, join, editable,
  show_last, display)` [R4]: re-bound by v4 position, and `transp` (visual only) is dropped.
- Colours: v4 already uses `color.red`, `color.new` [T4, M4], the same as v5, so nothing is rewritten. Bare `red`
  is v3 syntax and stays an error.
- `var`, `:=`, compound assignment, `for … to … by`, `break`/`continue`, tuples, `f(x) =>` and lazy `?:` all
  exist in v4 [S4, RN4, T4]. `and`/`or` take numbers and evaluate both sides [O4], the same as our v5.
  No `switch` or `while` in v4 (they arrived in v5); they keep the existing "not supported in v1" errors.

## (b) v6 differences that touch our subset
- `and` / `or` evaluate lazily, left first [M6]. Codegen short-circuits. A `ta.*` call on the right-hand side is
  conditionally executed, so it gets the same "inside a conditional" warning as `ta.*` in `if` / `?:`.
- int/float are no longer implicitly cast to bool [M6]. A light type inference (int/float/bool/string/color/unknown)
  makes it a line:col error to use an obviously numeric expression as an `if` / `?:` condition or as an
  `and` / `or` / `not` operand. Unknown types (function parameters, `na`, names with mixed types) never error.
  Since 2026-10-08 the inference also types:
  - self-referencing variables (`var x = 0`, `x := x + 1`): while a name's type is being computed, a reference to
    it is neutral, so the other sources decide;
  - compound assignments (`x += 1` counts as `x := x + 1`);
  - user-function results (the type of the function's last line, with parameters unknown).

  Partial results inside such a cycle are never cached. A corpus of 35 valid v6 scripts (src/pine/v6Corpus.test.ts)
  must compile without errors.
- bool cannot be na [M6]: `na(b)` / `nz(b)` on a known bool, and `bool b = na`, are errors. History of a bool
  variable before its first bar is `false`, not na.
  - [M6] says only that "A variable declared as bool can no longer be assigned na as its default value", and that
    "Expressions that returned a boolean na value in v5 now return false".
  - So a later `b := na` on a known bool is NOT an error (changed 2026-10-08; it was rejected before). It stores
    `false`.
  - Whether TradingView rejects `b := na` is unverified. We accept it, so a valid script never gets a false error.
- `for` loops re-evaluate their `to` bound before every iteration [M6]. The direction (up or down) is fixed by
  the first evaluation. The guide does not say what happens if the bound later crosses the start (unverified;
  this matches v5 whenever the bound does not move).
- `linewidth` must be at least 1 for `plot` / `hline` [M6]: a literal below 1 is an error.
- Already true in all versions, so no v6 code is needed:
  - `transp` was removed from plot [M6]; plot() has no `transp`.
  - Repeated arguments are an error [M6]; `bindArgs` already rejects them.
  - `[]` on literals is an error [M6]; already "history [] works on variables …".
  - Mutable variables are series [M6]; reassigned names are already rejected as `ta.*` lengths.
- Integer division: see "Arithmetic and conversions" below (since 2026-10-08 every version is exact).
- The colour values of `color.red`, `teal` and `yellow` changed [M6]. Colours are not drawn by value, so no effect.

## Arithmetic and conversions (all versions; added 2026-10-08)

**`int / int`.** The inference (src/pine/v6.ts, `exprTyper(program, version)`) types both operands; codegen emits
`rt.idiv` (quotient truncated toward zero) only when the division is typed int.
- v4: the same rule as v5 (const / const truncates).
  - [O4] says "If both operands are of type integer, then the result will also have the type integer". But the v6
    operators page has the same sentence next to "5/2 = 2.5", so it describes the TYPE, not truncation.
  - Integer division of series / input ints in v4 (`bar_index / 2`, `input(9, type=input.integer) / 2`) is
    UNVERIFIED, so it stays fractional like v5, as before 2026-10-08.
- v5: integer only when BOTH operands are "const". [M6 "Fractional division of constants"]: const/const `5/2 = 2`,
  but with an "input", "simple" or "series" operand `5/2 = 2.5`.
  - Our "const": int literals; arithmetic on them; names with a single plain (not `var`) declaration from such an
    expression that are never reassigned.
  - Inputs, `var` names, reassigned names, function parameters and series are not const.
- v6: always fractional [M6]: "dividing two 'int' values ... always results in a number with a fractional value,
  regardless of the type and qualifier". Use `int(a / b)` for the integer quotient.
- Literals written with a point or exponent (`1.0`, `1e3`) are float, even though their value is integral.
- Unknown operand types (function parameters, mixed-type names) always divide fractionally. `/=` follows the same
  rule as `x := x / v`.
- Unverified: TradingView's rounding direction for a negative int quotient in v4/v5. We truncate toward zero,
  consistent with `int()` and `%` below.

**Division and modulo by zero** give na, not ±Infinity (`rt.div`, `rt.idiv`, `rt.mod`; also `/=` and `%=`).
- The official docs say nothing on this (checked [O4], the v6 operators page, [M6], [R6]). [SO] (community, not
  official) says a runtime division by zero returns na. It also says a division whose divisor is a known const 0 is
  a COMPILE error in TradingView.
- We do not reproduce that compile error. Our const tracking is narrower than TradingView's, and an error there
  could fire on valid scripts. A const division by zero is na at runtime instead (unverified, conservative).

**`%`** truncates the quotient, so the result has the sign of the dividend [R6 `%`]: "-1 % 9 = -1". This is
JavaScript's `%`.

**`int(x)`, `float(x)`, `bool(x)`** exist in v4, v5 and v6 [R4, R5, R6].
- `int()` "Casts na or truncates float value to int" [R4, R5, R6]. It truncates toward zero, per the
  `int(-1/9) = int(-0.111) = 0` example in [R6] `%`. `int(na)` is na.
- `float()` "Casts na to float". `float(na)` is na.
- `bool()`:
  - v6: "Returns false if x is na, false, or an int/float value equal to 0. Returns true for all other possible
    values" [R6]. It is the documented fix for v6 numeric conditions [M6].
  - v4/v5: documented only as "Casts na to bool" [R4, R5], and a bool can be na there. So `bool(na)` stays na
    (false as a condition). For numbers we use the v5 implicit-cast rule [M5]: 0 is false, any other number true
    (unverified for an explicit `bool()`).
- A user function with the same name wins. A constant conversion (`len = int(14.9)`) is a valid ta.* length.

## (c) Not supported (explicit errors with line:col)
- v4: `security()`, `heikinashi()`, `renko()`, `kagi()`, `linebreak()`, `pointfigure()`, `tickerid()`,
  `financial()`, `quandl()`, `splits()`, `dividends()`, `earnings()`, `study(resolution=…)`, and `input` types
  other than integer/float/bool/source.
- v4 also rejects v5-only spellings: `indicator()` ("use study()"), `ta.*` / `math.*` ("use sma()" etc.) and
  `input.int()` etc. ("use input(…, type=input.integer)").
- v5/v6 give a friendly hint for v4 spellings: `study()`, bare `sma()` / `max()`, `tr`, `iff()`, `security()` and
  `input.integer`. The hint only replaces the generic "unknown function" / "not declared" message. Scripts that
  define their own `sma` keep working.
- Every version keeps the shared list: `strategy()`, `request.*`, arrays/maps/matrices, drawing objects,
  alerts, libraries, `switch`/`while`, UDTs and methods.
- Versions 1–3 and 7+.

## Decisions where the docs were silent
- Names are rewritten only where unambiguous: a user function or variable of the same name wins, and the tables
  are `Map`s (no prototype lookup for `constructor`, `hasOwnProperty`, …).
- Messages for v4 inputs that do not fit their type (for example a fractional default for an integer input)
  reuse the v5 wording (`input.int …`).
- In v6 a string/colour condition is not reported (only numbers are, as the guide describes).
