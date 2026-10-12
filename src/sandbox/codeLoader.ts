/**
 * Turns generated strategy / Pine code into a callable factory. The browser uses the page realm's Function
 * constructor (the code is AST-generated from fixed templates, with dangerous globals shadowed); the server swaps
 * in a node:vm loader so generated code runs in a separate realm that has no `process`, `require` or network.
 * Every place that executes generated code goes through loadFactory, so the swap covers all of them.
 */
export type FactoryLoader = (params: readonly string[], body: string) => (...args: unknown[]) => unknown;

const functionLoader: FactoryLoader = (params, body) => new Function(...params, body) as (...args: unknown[]) => unknown;

let current: FactoryLoader = functionLoader;

/** Compiles `body` as the body of a function taking `params`. Throws on syntax errors. */
export function loadFactory(params: readonly string[], body: string): (...args: unknown[]) => unknown {
  return current(params, body);
}

/** Replaces the loader for this realm (server workers); null restores the default. */
export function setFactoryLoader(loader: FactoryLoader | null): void {
  current = loader ?? functionLoader;
}
