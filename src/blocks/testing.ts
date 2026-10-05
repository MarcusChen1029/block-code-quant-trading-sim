import { BT } from './blockTypes';
import { indicatorBlockType } from './registry';
import type { BlockState, ConnectionState, VariableState, WorkspaceState } from './workspaceState';

/** Test helpers that build Blockly-format workspace JSON by hand. */

let nextId = 0;
const id = (prefix: string) => `${prefix}-${nextId++}`;

/** Links statement blocks through `next`; returns the first. */
export function chain(...blocks: BlockState[]): BlockState | undefined {
  for (let i = 0; i < blocks.length - 1; i++) blocks[i].next = { block: blocks[i + 1] };
  return blocks[0];
}

export const slot = (block: BlockState): ConnectionState => ({ block });
export const num = (value: number): BlockState => ({ type: 'math_number', id: id('num'), fields: { NUM: value } });
export const text = (value: string): BlockState => ({ type: 'text', id: id('text'), fields: { TEXT: value } });
export const price = (field = 'close', offset = 0): BlockState => ({ type: BT.price, id: id('price'), fields: { FIELD: field, OFFSET: offset } });
export const value = (type: string): BlockState => ({ type, id: id(type) });

export function indicator(ind: string, fields: Record<string, unknown>, source: BlockState | null = price()): BlockState {
  return { type: indicatorBlockType(ind), id: id(ind), fields, inputs: source ? { SOURCE: slot(source) } : {} };
}

export function log(message: BlockState, blockId = id('log')): BlockState {
  return { type: BT.log, id: blockId, inputs: { MSG: slot(message) } };
}

export function compare(op: string, a: BlockState, b: BlockState): BlockState {
  return { type: 'logic_compare', id: id('cmp'), fields: { OP: op }, inputs: { A: slot(a), B: slot(b) } };
}

export function ifThen(cond: BlockState, ...body: BlockState[]): BlockState {
  return { type: 'controls_if', id: id('if'), inputs: { IF0: slot(cond), DO0: { block: chain(...body) } } };
}

export function repeat(times: number, body: BlockState[], blockId = id('repeat')): BlockState {
  return { type: 'controls_repeat_ext', id: blockId, inputs: { TIMES: slot(num(times)), DO: { block: chain(...body) } } };
}

export const getVar = (varId: string): BlockState => ({ type: 'variables_get', id: id('get'), fields: { VAR: { id: varId } } });

export function setVar(varId: string, to: BlockState): BlockState {
  return { type: 'variables_set', id: id('set'), fields: { VAR: { id: varId } }, inputs: { VALUE: slot(to) } };
}

export function changeVar(varId: string, by: BlockState): BlockState {
  return { type: 'math_change', id: id('change'), fields: { VAR: { id: varId } }, inputs: { DELTA: slot(by) } };
}

export interface WorkspaceParts {
  onBar?: BlockState[];
  init?: BlockState[];
  /** Extra top-level blocks (function definitions, strays). */
  extra?: BlockState[];
  variables?: VariableState[];
}

export function workspace(parts: WorkspaceParts): WorkspaceState {
  const blocks: BlockState[] = [];
  if (parts.init) blocks.push({ type: BT.start, id: 'hat-start', next: { block: chain(...parts.init) } });
  if (parts.onBar) blocks.push({ type: BT.bar, id: 'hat-bar', next: { block: chain(...parts.onBar) } });
  blocks.push(...(parts.extra ?? []));
  return { blocks: { languageVersion: 0, blocks }, variables: parts.variables ?? [] };
}
