import {
  BT, CROSS_OPTIONS, EXIT_OPTIONS, MAX_PRICE_OFFSET, MIN_MAX_OPTIONS, POSITION_SIDE_OPTIONS, PRICE_FIELD_OPTIONS,
  SIDE_OPTIONS, SIZE_UNIT_OPTIONS, hasOption,
} from './blockTypes';
import type { PriceSource } from './priceSource';
import {
  blockParams, getIndicator, INDICATOR_BLOCK_PREFIX, missingIndicatorTitle, paramFieldName, PINE_ID_PREFIX, SIGNAL_BLOCK_PREFIX,
  type IndicatorBlockDef,
} from './registry';
import { readStaleChoice } from './staleChoice';
import { connected, isEnabled, type BlockState, type ConnectionState, type WorkspaceState } from './workspaceState';

export interface CompileIssue {
  message: string;
  /** The block to highlight, when the issue belongs to one. */
  blockId?: string;
}

/** One indicator block instance, reported so the UI can draw it. */
export interface IndicatorUse {
  indicatorId: string;
  params: Record<string, number>;
  /** The plain bar value it reads (offset 0), or null when it reads a computed series or no series at all. */
  source: PriceSource | null;
  /** True when the UI can recompute it from candles alone (no computed source). */
  drawable: boolean;
  blockId: string;
  /** Signal blocks: the signal keys it reads (the chart draws their markers). Absent for numeric blocks. */
  signals?: string[];
}

/** Generated JS plus the side tables the runtime needs. */
export interface GeneratedProgram {
  /** Body of `new Function('rt', ...)`; returns `{ init(ctx), onBar(ctx) }`. */
  source: string;
  /** `rt.at(i)` in the source refers to blockIds[i]. */
  blockIds: string[];
  /** Largest `n bars ago` used (sizes the history ring buffer). */
  maxOffset: number;
  indicators: IndicatorUse[];
  warnings: CompileIssue[];
}

export type GenerateResult =
  | { ok: true; program: GeneratedProgram }
  | { ok: false; errors: CompileIssue[]; warnings: CompileIssue[] };

/** A JS string literal for arbitrary user text (also escapes the U+2028/2029 line separators). */
export function jsString(text: string): string {
  return JSON.stringify(text).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** A JS number literal; negatives are parenthesised so they are safe next to any operator. */
export function jsNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`not a finite number: ${value}`);
  if (Object.is(value, -0) || value === 0) return '0';
  return value < 0 ? `(${value})` : String(value);
}

const HAT_LABEL: Record<string, string> = { [BT.start]: "'when strategy starts'", [BT.bar]: "'when a bar closes'" };
/** Names users see in messages (the text on the block), for blocks whose type name reads badly. */
const BLOCK_LABEL: Record<string, string> = {
  controls_if: 'if', controls_ifelse: 'if else', controls_repeat_ext: 'repeat', controls_repeat: 'repeat',
  logic_compare: 'compare', logic_operation: 'and / or', logic_negate: 'not', math_arithmetic: 'arithmetic',
  math_single: 'math function', math_round: 'round', math_change: 'change variable', variables_set: 'set variable',
  variables_get: 'variable', text_join: 'join', procedures_callnoreturn: 'call function', procedures_callreturn: 'call function',
  procedures_defnoreturn: 'function', procedures_defreturn: 'function', procedures_ifreturn: 'if return',
  [BT.minMax]: 'min / max', [BT.price]: 'price', [BT.volume]: 'volume', [BT.positionIs]: 'position is',
  [BT.marketOrder]: 'market order', [BT.limitOrder]: 'limit order', [BT.setExit]: 'set stop-loss / take-profit',
  [BT.clearExit]: 'remove stop-loss / take-profit', [BT.log]: 'log',
};
const PROC_DEFS = new Set(['procedures_defnoreturn', 'procedures_defreturn']);
const ARITHMETIC: Record<string, string> = { ADD: '+', MINUS: '-', MULTIPLY: '*', DIVIDE: '/', POWER: '**' };
const COMPARE: Record<string, string> = { EQ: '===', NEQ: '!==', LT: '<', LTE: '<=', GT: '>', GTE: '>=' };
const SINGLE: Record<string, (x: string) => string> = {
  ROOT: (x) => `Math.sqrt(${x})`, ABS: (x) => `Math.abs(${x})`, NEG: (x) => `(-${x})`, LN: (x) => `Math.log(${x})`,
  LOG10: (x) => `Math.log10(${x})`, EXP: (x) => `Math.exp(${x})`, POW10: (x) => `(10 ** ${x})`,
};
const ROUND: Record<string, string> = { ROUND: 'Math.round', ROUNDUP: 'Math.ceil', ROUNDDOWN: 'Math.floor' };
const CONTEXT_VALUES: Record<string, string> = {
  [BT.product]: 'ctx.symbol',
  [BT.timeframe]: 'ctx.timeframe',
  [BT.currentPrice]: 'ctx.candle.close',
  [BT.barTime]: 'ctx.candle.time',
  [BT.barIndex]: 'ctx.barIndex',
  [BT.balance]: 'ctx.balance',
  [BT.equity]: 'ctx.equity',
  [BT.positionSide]: 'ctx.position.side',
  [BT.positionSize]: 'ctx.position.qty',
  [BT.entryPrice]: 'ctx.position.entryPrice',
  [BT.unrealizedPnl]: 'ctx.unrealizedPnl',
  [BT.openOrders]: 'ctx.openOrderCount',
};
// Block types and dropdown values come from user-loadable JSON: tables must not resolve `constructor`, `toString`, etc.
for (const table of [HAT_LABEL, BLOCK_LABEL, ARITHMETIC, COMPARE, SINGLE, ROUND, CONTEXT_VALUES]) {
  Object.setPrototypeOf(table, null);
}

interface ProcInfo {
  index: number;
  name: string;
  paramIds: string[];
  hasReturn: boolean;
  block: BlockState;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function toNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw);
  return NaN;
}

class Generator {
  private readonly errors: CompileIssue[] = [];
  private readonly warnings: CompileIssue[] = [];
  private readonly blockIds: string[] = [];
  private readonly blockIndex = new Map<BlockState, number>();
  private readonly varIndex = new Map<string, number>();
  private readonly varIdByName = new Map<string, string>();
  private readonly procs = new Map<string, ProcInfo>();
  private readonly instances: string[] = [];
  private readonly crossers: string[] = [];
  private readonly hoisted: string[] = [];
  private readonly uses: IndicatorUse[] = [];
  private readonly warnedVarReads = new Set<string>();
  private cacheSlots = 0;
  private maxOffset = 0;
  private hoistDepth = 0;
  private params: Map<string, string> | null = null;
  private proc: ProcInfo | null = null;

  run(input: unknown): GenerateResult {
    try {
      return this.generate(input);
    } catch (err) {
      // Only reachable for pathological input, e.g. nesting deep enough to overflow the stack.
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, errors: [{ message: `could not compile the workspace: ${message}` }], warnings: this.warnings };
    }
  }

  private generate(input: unknown): GenerateResult {
    const state = record(input) as WorkspaceState;
    const top = Array.isArray(state.blocks?.blocks) ? state.blocks.blocks.filter((b) => typeof record(b).type === 'string') : [];
    for (const v of Array.isArray(state.variables) ? state.variables : []) {
      if (typeof v?.id !== 'string') continue;
      if (!this.varIndex.has(v.id)) this.varIndex.set(v.id, this.varIndex.size);
      if (typeof v.name === 'string') this.varIdByName.set(v.name, v.id);
    }

    const enabled = top.filter(isEnabled);
    for (const block of enabled.filter((b) => PROC_DEFS.has(b.type))) this.registerProc(block);

    const hats: Record<string, BlockState | undefined> = Object.create(null);
    for (const block of enabled) {
      if (block.type === BT.start || block.type === BT.bar) {
        if (hats[block.type]) this.error(`Only one ${HAT_LABEL[block.type]} block is allowed`, block);
        else hats[block.type] = block;
      } else if (!PROC_DEFS.has(block.type)) {
        this.warn("This block is not attached to a 'when …' block, so it never runs", block);
      }
    }
    if (!hats[BT.bar]) this.errors.push({ message: "Add a 'when a bar closes' block: it is where the strategy logic goes" });

    const procCode = [...this.procs.values()].map((p) => this.procedure(p));
    const startHat = hats[BT.start];
    const barHat = hats[BT.bar];
    const initBody = startHat ? this.statements(startHat.next) : '';
    const barBody = barHat ? this.statements(barHat.next) : '';
    if (barHat && barBody === '') this.warn("'when a bar closes' has no blocks under it, so the strategy never trades", barHat);

    if (this.errors.length > 0) return { ok: false, errors: this.errors, warnings: this.warnings };
    const source = [
      '"use strict";',
      `const V = [${Array.from({ length: this.varIndex.size }, () => '0').join(', ')}];`,
      `const I = [${this.instances.join(', ')}];`,
      `const X = [${this.crossers.join(', ')}];`,
      'const C = [];',
      'let ctx;',
      'function hoist() {',
      ...this.hoisted,
      '}',
      ...procCode,
      'return {',
      'init(c) {',
      'ctx = c;',
      'if (rt.beginBar(c)) hoist();',
      initBody,
      '},',
      'onBar(c) {',
      'ctx = c;',
      'if (rt.beginBar(c)) hoist();',
      barBody,
      '},',
      '};',
    ].join('\n');
    return {
      ok: true,
      program: { source, blockIds: this.blockIds, maxOffset: this.maxOffset, indicators: this.uses, warnings: this.warnings },
    };
  }

  // ---- bookkeeping -------------------------------------------------------------------------------

  private index(block: BlockState): number {
    let i = this.blockIndex.get(block);
    if (i === undefined) {
      i = this.blockIds.length;
      this.blockIds.push(typeof block.id === 'string' ? block.id : `#${i}`);
      this.blockIndex.set(block, i);
    }
    return i;
  }

  private issue(message: string, block?: BlockState): CompileIssue {
    return block && typeof block.id === 'string' ? { message, blockId: block.id } : { message };
  }

  private error(message: string, block?: BlockState): void {
    this.errors.push(this.issue(message, block));
  }

  private warn(message: string, block?: BlockState): void {
    this.warnings.push(this.issue(message, block));
  }

  private describe(block: BlockState): string {
    if (HAT_LABEL[block.type]) return HAT_LABEL[block.type];
    if (block.type === BT.crosses) return block.fields?.OP === 'under' ? "'crosses under'" : "'crosses over'";
    const ind = block.type.startsWith(INDICATOR_BLOCK_PREFIX) ? getIndicator(block.type.slice(INDICATOR_BLOCK_PREFIX.length))
      : block.type.startsWith(SIGNAL_BLOCK_PREFIX) ? getIndicator(block.type.slice(SIGNAL_BLOCK_PREFIX.length)) : undefined;
    return `'${ind ? ind.label : BLOCK_LABEL[block.type] ?? block.type.replace(/_/g, ' ')}'`;
  }

  // ---- procedures --------------------------------------------------------------------------------

  private registerProc(block: BlockState): void {
    const name = block.fields?.NAME;
    if (typeof name !== 'string' || name === '') {
      this.error('This function needs a name', block);
      return;
    }
    if (this.procs.has(name)) {
      this.error(`Two functions are named "${name}"`, block);
      return;
    }
    const params = Array.isArray(record(block.extraState).params) ? (record(block.extraState).params as unknown[]) : [];
    const paramIds = params.map((p, i) => {
      const { id, name: pName } = record(p);
      if (typeof id === 'string') return id;
      if (typeof pName === 'string' && this.varIdByName.has(pName)) return this.varIdByName.get(pName)!;
      return `#param${this.procs.size}_${i}`;
    });
    this.procs.set(name, { index: this.procs.size, name, paramIds, hasReturn: block.type === 'procedures_defreturn', block });
  }

  private procedure(proc: ProcInfo): string {
    const k = this.index(proc.block);
    this.proc = proc;
    this.params = new Map(proc.paramIds.map((id, i) => [id, `a${i}`]));
    const body = this.statements(proc.block.inputs?.STACK);
    const ret = proc.hasReturn ? `rt.at(${k});\nreturn ${this.value(proc.block, 'RETURN', 'return')};` : '';
    this.params = null;
    this.proc = null;
    return `function p${proc.index}(${proc.paramIds.map((_, i) => `a${i}`).join(', ')}) {\nrt.call(${k});\n${body}\n${ret}\n}`;
  }

  private call(block: BlockState, k: number, asValue: boolean): string {
    if (this.hoistDepth > 0) {
      this.error("Function calls can't be used inside indicator or 'crosses' inputs (those run at the start of every bar)", block);
      return 'NaN';
    }
    const name = record(block.extraState).name ?? block.fields?.NAME;
    const proc = typeof name === 'string' ? this.procs.get(name) : undefined;
    if (!proc) {
      this.error(`This calls a function "${String(name)}" that does not exist (or is disabled)`, block);
      return 'NaN';
    }
    if (asValue && !proc.hasReturn) this.error(`Function "${proc.name}" does not return a value`, block);
    const args = proc.paramIds.map((_, i) => this.value(block, `ARG${i}`, `input ${i + 1}`)).join(', ');
    return asValue ? `rt.ret(p${proc.index}(${args}), ${k})` : `p${proc.index}(${args})`;
  }

  // ---- statements --------------------------------------------------------------------------------

  private statements(conn: ConnectionState | undefined): string {
    const out: string[] = [];
    for (let block = connected(conn); block; block = connected(block.next)) {
      if (isEnabled(block)) out.push(this.statement(block));
    }
    return out.join('\n');
  }

  private statement(block: BlockState): string {
    const k = this.index(block);
    const at = `rt.at(${k});\n`;
    const f = block.fields ?? {};
    switch (block.type) {
      case 'controls_if':
      case 'controls_ifelse': {
        const extra = record(block.extraState);
        const elseIfs = block.type === 'controls_if' ? Math.max(0, Math.min(1000, Math.floor(toNumber(extra.elseIfCount)) || 0)) : 0;
        const hasElse = block.type === 'controls_ifelse' || extra.hasElse === true;
        let code = '';
        for (let i = 0; i <= elseIfs; i++) {
          const cond = this.value(block, `IF${i}`, i === 0 ? 'condition' : `else-if condition ${i}`);
          code += `${i > 0 ? ' else ' : ''}if (${cond}) {\n${this.statements(block.inputs?.[`DO${i}`])}\n}`;
        }
        if (hasElse) code += ` else {\n${this.statements(block.inputs?.ELSE)}\n}`;
        return at + code;
      }
      case 'controls_repeat_ext':
      case 'controls_repeat': {
        const times = block.type === 'controls_repeat' ? this.num(f.TIMES, block, 'times') : this.value(block, 'TIMES', 'times');
        const body = this.statements(block.inputs?.DO);
        return `${at}for (let i${k} = 0, n${k} = rt.times(${times}); i${k} < n${k}; i${k}++) {\nrt.loop(${k});\n${body}\n}`;
      }
      case 'variables_set':
        return `${at}${this.variable(block)} = ${this.value(block, 'VALUE', 'value')};`;
      case 'math_change': {
        const v = this.variable(block);
        return `${at}${v} = (typeof ${v} === 'number' ? ${v} : 0) + ${this.value(block, 'DELTA', 'amount')};`;
      }
      case 'procedures_callnoreturn':
        return `${at}${this.call(block, k, false)};`;
      case 'procedures_ifreturn': {
        if (!this.proc) {
          this.error("'if return' only works inside a function", block);
          return '';
        }
        const cond = this.value(block, 'CONDITION', 'condition');
        const val = this.proc.hasReturn ? ` ${this.value(block, 'VALUE', 'return value')}` : '';
        return `${at}if (${cond}) {\nreturn${val};\n}`;
      }
      case BT.marketOrder:
      case BT.limitOrder: {
        const side = this.option(f.SIDE, SIDE_OPTIONS, block, 'side');
        const unit = this.option(f.UNIT, SIZE_UNIT_OPTIONS, block, 'size unit');
        const size = this.value(block, 'SIZE', 'size');
        const fn = side === 'sell' ? 'sell' : 'buy';
        // Through the runtime: an na size / limit price skips the order with a warning instead of aborting (runtime.ts).
        if (block.type === BT.marketOrder) return `${at}rt.order(ctx, "${fn}", { type: "market", size: ${size}, unit: ${jsString(unit)} });`;
        const price = this.value(block, 'PRICE', 'limit price');
        return `${at}rt.order(ctx, "${fn}", { type: "limit", size: ${size}, unit: ${jsString(unit)}, price: ${price} });`;
      }
      case BT.setExit: {
        const kind = this.option(f.KIND, EXIT_OPTIONS, block, 'exit type');
        return `${at}rt.setExit(ctx, ${jsString(kind)}, ${this.value(block, 'PRICE', 'price')});`;
      }
      case BT.clearExit: {
        const kind = this.option(f.KIND, EXIT_OPTIONS, block, 'exit type');
        return `${at}ctx.${kind === 'takeProfit' ? 'setTakeProfit' : 'setStopLoss'}(null);`;
      }
      case BT.closePosition:
        return `${at}ctx.closePosition();`;
      case BT.cancelOrders:
        return `${at}ctx.cancelOrders();`;
      case BT.log:
        return `${at}ctx.log(rt.text(${this.value(block, 'MSG', 'message')}));`;
      default:
        this.error(`${this.describe(block)} can't be used as a command here`, block);
        return '';
    }
  }

  // ---- expressions -------------------------------------------------------------------------------

  /** Code for the block plugged into `parent.inputs[name]`; an empty slot is a compile error. */
  private value(parent: BlockState, name: string, label: string): string {
    const block = connected(parent.inputs?.[name]);
    if (!block || !isEnabled(block)) {
      this.error(`${this.describe(parent)}: the ${label} slot is empty`, parent);
      return 'NaN';
    }
    return this.expression(block);
  }

  /** Like value(), for inputs evaluated in hoist() at the start of the bar. */
  private hoistedValue(parent: BlockState, name: string, label: string): string {
    this.hoistDepth++;
    try {
      return this.value(parent, name, label);
    } finally {
      this.hoistDepth--;
    }
  }

  private expression(block: BlockState): string {
    const k = this.index(block);
    const f = block.fields ?? {};
    if (CONTEXT_VALUES[block.type]) return CONTEXT_VALUES[block.type];
    switch (block.type) {
      case 'math_number':
        return this.num(f.NUM, block, 'number');
      case 'logic_boolean':
        return f.BOOL === 'TRUE' ? 'true' : 'false';
      case 'text':
        return jsString(typeof f.TEXT === 'string' ? f.TEXT : String(f.TEXT ?? ''));
      case 'text_join': {
        const count = Math.max(0, Math.min(100, Math.floor(toNumber(record(block.extraState).itemCount)) || 0));
        const parts: string[] = [];
        for (let i = 0; i < count; i++) {
          const item = connected(block.inputs?.[`ADD${i}`]);
          if (item && isEnabled(item)) parts.push(`rt.text(${this.expression(item)})`);
        }
        return parts.length === 0 ? '""' : `(${parts.join(' + ')})`;
      }
      case 'math_arithmetic': {
        const op = ARITHMETIC[String(f.OP)];
        if (!op) return this.badOption(block, 'operator');
        return `(${this.value(block, 'A', 'left')} ${op} ${this.value(block, 'B', 'right')})`;
      }
      case 'math_single': {
        const fn = SINGLE[String(f.OP)];
        if (!fn) return this.badOption(block, 'function');
        return fn(this.value(block, 'NUM', 'number'));
      }
      case 'math_round': {
        const fn = ROUND[String(f.OP)];
        if (!fn) return this.badOption(block, 'rounding');
        return `${fn}(${this.value(block, 'NUM', 'number')})`;
      }
      case BT.minMax: {
        const op = this.option(f.OP, MIN_MAX_OPTIONS, block, 'min/max');
        return `Math.${op === 'MAX' ? 'max' : 'min'}(${this.value(block, 'A', 'first')}, ${this.value(block, 'B', 'second')})`;
      }
      case 'logic_compare': {
        const op = COMPARE[String(f.OP)];
        if (!op) return this.badOption(block, 'comparison');
        return `(${this.value(block, 'A', 'left')} ${op} ${this.value(block, 'B', 'right')})`;
      }
      case 'logic_operation': {
        const op = f.OP === 'AND' ? '&&' : f.OP === 'OR' ? '||' : '';
        if (!op) return this.badOption(block, 'operator');
        return `(${this.value(block, 'A', 'left')} ${op} ${this.value(block, 'B', 'right')})`;
      }
      case 'logic_negate':
        return `(!${this.value(block, 'BOOL', 'condition')})`;
      case 'variables_get':
        return this.variable(block);
      case 'procedures_callreturn':
        return this.call(block, k, true);
      case BT.price:
      case BT.volume: {
        const field = block.type === BT.volume ? 'volume' : this.option(f.FIELD, PRICE_FIELD_OPTIONS, block, 'price field');
        const offset = toNumber(f.OFFSET ?? 0);
        if (!Number.isInteger(offset) || offset < 0 || offset > MAX_PRICE_OFFSET) {
          this.error(`${this.describe(block)}: "bars ago" must be a whole number from 0 to ${MAX_PRICE_OFFSET}`, block);
          return 'NaN';
        }
        this.maxOffset = Math.max(this.maxOffset, offset);
        return `rt.price(${jsString(field)}, ${offset})`;
      }
      case BT.positionIs: {
        const side = this.option(f.SIDE, POSITION_SIDE_OPTIONS, block, 'position side');
        return `(ctx.position.side === ${jsString(side)})`;
      }
      case BT.crosses:
        return this.crosses(block, k);
      default: {
        const isInd = block.type.startsWith(INDICATOR_BLOCK_PREFIX);
        const isSig = block.type.startsWith(SIGNAL_BLOCK_PREFIX);
        const def = isInd ? getIndicator(block.type.slice(INDICATOR_BLOCK_PREFIX.length))
          : isSig ? getIndicator(block.type.slice(SIGNAL_BLOCK_PREFIX.length)) : undefined;
        if (def && isInd && def.outputs.length > 0) return this.indicator(block, k, def);
        if (def && isSig && (def.signals ?? []).length > 0) return this.signal(block, k, def);
        if (def) {
          this.error(isInd
            ? `${def.label} has no numeric outputs any more (only signals): use its signal block from the toolbox`
            : `${def.label} has no signals any more: use its numeric block from the toolbox`, block);
          return 'NaN';
        }
        if (block.type.startsWith(INDICATOR_BLOCK_PREFIX + PINE_ID_PREFIX) || block.type.startsWith(SIGNAL_BLOCK_PREFIX + PINE_ID_PREFIX)) {
          const id = block.type.slice((isSig ? SIGNAL_BLOCK_PREFIX : INDICATOR_BLOCK_PREFIX).length);
          const name = missingIndicatorTitle(id) ?? id.slice(PINE_ID_PREFIX.length);
          this.error(`Pine script "${name}" is missing: it was deleted or no longer compiles. Fix it in the Pine tab, or remove this block`, block);
          return 'NaN';
        }
        this.error(`Unknown or unsupported block "${block.type}"`, block);
        return 'NaN';
      }
    }
  }

  private variable(block: BlockState): string {
    const field = record(block.fields?.VAR);
    let id = typeof field.id === 'string' ? field.id : undefined;
    if (!id && typeof field.name === 'string') id = this.varIdByName.get(field.name);
    if (!id) {
      this.error(`${this.describe(block)} needs a variable`, block);
      return 'NaN';
    }
    const param = this.params?.get(id);
    if (param) {
      if (this.hoistDepth > 0) {
        this.error("A function input can't be used inside indicator or 'crosses' inputs (those run at the start of every bar)", block);
        return 'NaN';
      }
      return param;
    }
    if (!this.varIndex.has(id)) this.varIndex.set(id, this.varIndex.size);
    if (this.hoistDepth > 0 && !this.warnedVarReads.has(id)) {
      this.warnedVarReads.add(id);
      this.warn('Indicator and crosses inputs run at the start of each bar, so this variable has its value from the end of the previous bar', block);
    }
    return `V[${this.varIndex.get(id)}]`;
  }

  /** Indicator call-site: one stateful instance, stepped in hoist() on EVERY bar; the expression reads the cache. */
  private indicator(block: BlockState, k: number, def: IndicatorBlockDef): string {
    const stale = readStaleChoice(block);
    if (stale?.field === 'OUT') {
      this.error(`${def.label}: output "${stale.title}" no longer exists in the script (renamed or removed): choose an output in this block`, block);
    }
    let output = def.outputs[0].key;
    if (def.outputs.length > 1) {
      const out = block.fields?.OUT;
      if (def.outputs.some((o) => o.key === out)) output = out as string;
      else if (out !== undefined) this.error(`${def.label}: unknown output "${String(out)}"`, block);
    }
    return `C[${this.instance(block, k, def, 'ind')}][${jsString(output)}]`;
  }

  /**
   * Signal call-site (`sig_` block): exactly like an indicator block (own instance, hoisted, stepped every bar,
   * so its state updates even inside an if that is not taken); reads true when the chosen signal fired.
   * An `ind_` and a `sig_` block of the same script each get their own instance (duplicate work, same values).
   */
  private signal(block: BlockState, k: number, def: IndicatorBlockDef): string {
    // Never fall back to another signal: a missing or vanished choice is an error on this block.
    const signals = def.signals ?? [];
    let key = signals[0].key;
    const chosen = block.fields?.SIGOUT;
    const stale = readStaleChoice(block);
    if (stale?.field === 'SIGOUT') {
      this.error(`${def.label}: signal "${stale.title}" no longer exists in the script (renamed or removed): choose a signal in this block`, block);
    } else if (chosen === undefined) {
      this.error(`${def.label}: no signal is chosen in this block`, block);
    } else if (signals.some((s) => s.key === chosen)) {
      key = chosen as string;
    } else {
      this.error(`${def.label}: signal "${String(chosen)}" does not exist (renamed or removed?): choose a signal in this block`, block);
    }
    return `(C[${this.instance(block, k, def, 'sig', key)}][${jsString(key)}] === 1)`;
  }

  /** Creates the hoisted instance of an indicator / signal block; returns its cache slot. */
  private instance(block: BlockState, k: number, def: IndicatorBlockDef, kind: 'ind' | 'sig', signalKey?: string): number {
    const params: Record<string, number> = {};
    for (const p of blockParams(def, kind)) {
      const raw = block.fields?.[paramFieldName(p)];
      const v = raw === undefined ? p.default : toNumber(raw);
      const okRange = Number.isFinite(v) && (p.min === undefined || v >= p.min) && (p.max === undefined || v <= p.max);
      if (!okRange || (p.integer && !Number.isInteger(v))) {
        const kind = p.integer ? 'a whole number' : 'a number';
        this.error(`${def.label} ${p.label} must be ${kind} from ${p.min ?? '-∞'} to ${p.max ?? '∞'}`, block);
        params[p.name] = p.default;
      } else {
        params[p.name] = v;
      }
    }
    let source = 'NaN';
    let sourceField: PriceSource | null = null;
    if (def.source) {
      const src = connected(block.inputs?.SOURCE);
      source = this.hoistedValue(block, 'SOURCE', 'source');
      const srcFields = src?.fields ?? {};
      if (src?.type === BT.price && toNumber(srcFields.OFFSET ?? 0) === 0 && hasOption(PRICE_FIELD_OPTIONS, srcFields.FIELD)) {
        sourceField = srcFields.FIELD as PriceSource;
      } else if (src?.type === BT.volume && toNumber(srcFields.OFFSET ?? 0) === 0) {
        sourceField = 'volume';
      }
    }
    const inst = this.instances.length;
    // `rt.at(k)` first, so an error while creating the instance (e.g. a bad length) names this block.
    this.instances.push(`(rt.at(${k}), rt.indicator(${jsString(def.id)}, { ${Object.keys(params).map((name) => `${name}: ${jsNumber(params[name])}`).join(', ')} }))`);
    const slot = this.cacheSlots++;
    this.hoisted.push(`rt.at(${k}); C[${slot}] = I[${inst}].step(${source}, ctx.candle);`);
    const use: IndicatorUse = {
      indicatorId: def.id, params, source: sourceField,
      drawable: !def.source || sourceField !== null, blockId: this.blockIds[k],
    };
    if (signalKey !== undefined) use.signals = [signalKey];
    this.uses.push(use);
    return slot;
  }

  /** crosses over/under call-site: hoisted like an indicator; keeps both sides' previous-bar values. */
  private crosses(block: BlockState, k: number): string {
    const kind = this.option(block.fields?.OP, CROSS_OPTIONS, block, 'crosses over/under');
    const a = this.hoistedValue(block, 'A', 'left');
    const b = this.hoistedValue(block, 'B', 'right');
    const x = this.crossers.length;
    this.crossers.push(`rt.cross(${jsString(kind)})`);
    const slot = this.cacheSlots++;
    this.hoisted.push(`rt.at(${k}); C[${slot}] = X[${x}].update(${a}, ${b});`);
    return `C[${slot}]`;
  }

  private num(raw: unknown, block: BlockState, label: string): string {
    const v = toNumber(raw);
    if (!Number.isFinite(v)) {
      this.error(`${this.describe(block)}: ${label} must be a number`, block);
      return 'NaN';
    }
    return jsNumber(v);
  }

  /** Returns the dropdown value if it is one of `options`; otherwise records an error and returns the first. */
  private option(raw: unknown, options: ReadonlyArray<readonly [string, string]>, block: BlockState, label: string): string {
    if (hasOption(options, raw)) return raw;
    this.error(`${this.describe(block)}: invalid ${label} "${String(raw)}"`, block);
    return options[0][1];
  }

  private badOption(block: BlockState, label: string): string {
    this.error(`${this.describe(block)}: invalid ${label}`, block);
    return 'NaN';
  }
}

/** Compiles a saved Blockly workspace (JSON) to JS source. Pure: no Blockly, no DOM. */
export function generateProgram(workspace: unknown): GenerateResult {
  return new Generator().run(workspace);
}
