import { afterEach, describe, expect, it } from 'vitest';
import { strategyFromProgram } from '../../../src/blocks/compiler';
import { setFactoryLoader } from '../../../src/sandbox/codeLoader';
import { createVmLoader, vmForbiddenReferences } from './vmLoader';

afterEach(() => setFactoryLoader(null));

describe('vm loader identifier gate', () => {
  it('finds forbidden identifiers outside string literals, and template literals', () => {
    expect(vmForbiddenReferences('return a.constructor')).toEqual(['constructor']);
    expect(vmForbiddenReferences('var x = "constructor this stack"; return x')).toEqual([]);
    expect(vmForbiddenReferences("return 'eval' + e.stack")).toEqual(['stack']);
    expect(vmForbiddenReferences('return this')).toEqual(['this']);
    expect(vmForbiddenReferences('return `x`')).toEqual(['template literal']);
    expect(vmForbiddenReferences('rt.at(0); ctx.buy({ size: 1 }); return rt.price("close", 0)')).toEqual([]);
  });

  it('refuses the evasions a naive tokenizer misses (comments, escapes, regex, string and computed keys)', () => {
    const refused = (js: string) => vmForbiddenReferences(js).length > 0;
    expect(refused('return a["constructor"]')).toBe(true);
    expect(refused("return a['__proto__']")).toBe(true);
    expect(refused('var k = "con" + "structor"; return a[k]')).toBe(true); // computed non-literal key
    expect(refused('return a[b]')).toBe(true);
    expect(refused('return x /* hidden */ + 1')).toBe(true);
    expect(refused('return x // hidden\n')).toBe(true);
    expect(refused('return a.\\u0063onstructor')).toBe(true); // unicode escape in an identifier
    expect(refused('var r = /constructor/; return r')).toBe(true);
    expect(refused('var r = /abc/; return r')).toBe(true); // any regex literal
    // What generated code really looks like still passes: string keys, numeric indexes, array literals, division.
    expect(vmForbiddenReferences('var I = [(rt.at(5), rt.x(1))]; return C[0]["value"] / P[1] + (a) / 2 - [b][0]')).toEqual([]);
    expect(vmForbiddenReferences('ctx.log("a // b /* c */ \\"q\\" constructorish")')).toEqual([]); // data inside strings
  });

  it('the default (gated) loader refuses such code before compiling it', () => {
    const load = createVmLoader();
    expect(() => load(['h'], 'return h.constructor')).toThrow(/generated code mentions constructor/);
    expect(() => load(['h'], 'function f(n) { return f(n + 1) } try { f(0) } catch (e) { return e.stack }')).toThrow(/generated code mentions stack/);
    expect(load(['h'], 'return h + 1')(1)).toBe(2);
  });

  it('a block program naming a forbidden identifier cannot even be instantiated', () => {
    setFactoryLoader(createVmLoader());
    const program = {
      source: 'return { init: function () {}, onBar: function (ctx) { return this.constructor; } };',
      blockIds: ['b0'], maxOffset: 0, indicators: [], warnings: [],
    };
    expect(() => strategyFromProgram(program as never)).toThrow(/generated code mentions (this, constructor|constructor, this)/);
  });
});
