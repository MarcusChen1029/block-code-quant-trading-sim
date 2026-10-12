import vm, { type Context } from 'node:vm';
import type { FactoryLoader } from '../../../src/sandbox/codeLoader';

/**
 * Strategy / Pine code generated on the server runs in its own V8 realm (node:vm), on top of the generator's own
 * guarantees (AST-only templates, shadowed globals). The realm:
 * - has only the ECMAScript built-ins: no `process`, `require`, `fetch`, timers, `console`, module loader;
 * - cannot compile code from strings (`Function`/`eval` throw), so `this.constructor.constructor` is a dead end;
 * - has no dynamic-import callback, so `import()` rejects;
 * - has every built-in deeply frozen before any generated code runs (nobody can patch the membrane's tools).
 *
 * Generated code receives host objects (the block runtime, the strategy context, Pine runtime arrays) only through
 * a two-way membrane: host objects appear as vm-realm proxies, and vm objects handed to the host appear as
 * proxies too. Neither side ever holds a raw object of the other realm, so the host realm's `Function` (and with
 * it `process`) is never reachable. `constructor`, `__proto__`, `prototype` and friends are not forwarded and
 * prototypes read as null. Errors keep their identity when they cross back (a host StrategyError thrown through
 * generated code reaches the host as the same object); errors made in the vm become host Errors with the same
 * message and name.
 */

const MEMBRANE = String.raw`
(function createMembrane(makeHostError) {
  'use strict';
  const R = Reflect;
  const apply = R.apply, rGet = R.get, rSet = R.set, rHas = R.has, rOwnKeys = R.ownKeys, rGetOwn = R.getOwnPropertyDescriptor;
  const isArray = Array.isArray;
  const WM = WeakMap, wmGet = WM.prototype.get, wmSet = WM.prototype.set, wmHas = WM.prototype.has;
  const PX = Proxy;
  const VmError = Error;
  const defineProperty = Object.defineProperty;
  const TypeErr = TypeError;
  const DENIED = { __proto__: null, constructor: 1, prototype: 1, caller: 1, callee: 1, arguments: 1,
    __defineGetter__: 1, __defineSetter__: 1, __lookupGetter__: 1, __lookupSetter__: 1 };
  const denied = (key) => typeof key === 'string' && (key === '__proto__' || DENIED[key] === 1);

  const toVm = new WM();      // host object -> vm-facing proxy
  const vmToHostObj = new WM(); // vm-facing proxy -> host object
  const toHost = new WM();    // vm object -> host-facing proxy
  const hostToVmObj = new WM(); // host-facing proxy -> vm object
  const vmErrOrigin = new WM(); // vm error -> the host error it stands for
  const hostErrOrigin = new WM(); // host error made from a vm error -> that vm error

  const m = (map, fn, ...args) => apply(fn, map, args);
  const isObj = (v) => (typeof v === 'object' && v !== null) || typeof v === 'function';
  const target = (v) => (typeof v === 'function' ? () => {} : isArray(v) ? [] : {});

  function messageOf(e) {
    try {
      const msg = isObj(e) ? e.message : undefined;
      return typeof msg === 'string' ? msg : String(e);
    } catch (_) {
      return 'error';
    }
  }
  function nameOf(e) {
    try {
      const name = isObj(e) ? e.name : undefined;
      return typeof name === 'string' ? name : 'Error';
    } catch (_) {
      return 'Error';
    }
  }

  // ---- host -> vm -------------------------------------------------------------------------------------------
  function hostErrorToVm(e) {
    if (!isObj(e)) return e;
    if (m(hostErrOrigin, wmHas, e)) return m(hostErrOrigin, wmGet, e);
    const err = new VmError(messageOf(e));
    defineProperty(err, 'name', { __proto__: null, value: nameOf(e), writable: true, enumerable: false, configurable: true });
    m(vmErrOrigin, wmSet, err, e);
    return err;
  }
  function wrap(h) {
    if (!isObj(h)) return h;
    if (m(hostToVmObj, wmHas, h)) return m(hostToVmObj, wmGet, h);
    if (m(toVm, wmHas, h)) return m(toVm, wmGet, h);
    const p = new PX(target(h), vmFacing(h));
    m(toVm, wmSet, h, p);
    m(vmToHostObj, wmSet, p, h);
    return p;
  }
  function wrapArgs(args) {
    const out = [];
    for (let i = 0; i < args.length; i++) defineProperty(out, i, { __proto__: null, value: wrap(args[i]), writable: true, enumerable: true, configurable: true });
    return out;
  }
  function vmFacing(h) {
    return {
      __proto__: null,
      get(_t, key) {
        if (denied(key)) return undefined;
        try { return wrap(rGet(h, key)); } catch (e) { throw hostErrorToVm(e); }
      },
      set(_t, key, value) {
        if (denied(key)) return false;
        try { return rSet(h, key, unwrap(value)); } catch (e) { throw hostErrorToVm(e); }
      },
      has(_t, key) {
        if (denied(key)) return false;
        try { return rHas(h, key); } catch (e) { throw hostErrorToVm(e); }
      },
      ownKeys(t) {
        let keys;
        try { keys = rOwnKeys(h); } catch (e) { throw hostErrorToVm(e); }
        const out = [];
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          if (!denied(k) || rGetOwn(t, k)) defineProperty(out, out.length, { __proto__: null, value: k, writable: true, enumerable: true, configurable: true });
        }
        return out;
      },
      getOwnPropertyDescriptor(t, key) {
        if (denied(key)) return rGetOwn(t, key);
        let d;
        try { d = rGetOwn(h, key); } catch (e) { throw hostErrorToVm(e); }
        if (d === undefined) return undefined;
        const fixed = rGetOwn(t, key);
        const nonConfigurable = fixed !== undefined && fixed.configurable === false;
        let value;
        try { value = wrap(rGet(h, key)); } catch (e) { throw hostErrorToVm(e); }
        return { __proto__: null, value, writable: nonConfigurable ? fixed.writable : true, enumerable: d.enumerable, configurable: !nonConfigurable };
      },
      defineProperty() { return false; },
      deleteProperty() { return false; },
      getPrototypeOf() { return null; },
      setPrototypeOf() { return false; },
      preventExtensions() { return false; },
      apply(_t, thisArg, args) {
        let result;
        try { result = apply(h, unwrap(thisArg), unwrapArgs(args)); } catch (e) { throw hostErrorToVm(e); }
        return wrap(result);
      },
      construct() { throw new TypeErr('host objects cannot be constructed from generated code'); },
    };
  }

  // ---- vm -> host -------------------------------------------------------------------------------------------
  function vmErrorToHost(e) {
    if (!isObj(e)) return e;
    if (m(vmErrOrigin, wmHas, e)) return m(vmErrOrigin, wmGet, e);
    const err = makeHostError(messageOf(e), nameOf(e));
    m(hostErrOrigin, wmSet, err, e);
    return err;
  }
  function unwrap(v) {
    if (!isObj(v)) return v;
    if (m(vmToHostObj, wmHas, v)) return m(vmToHostObj, wmGet, v);
    if (m(toHost, wmHas, v)) return m(toHost, wmGet, v);
    const p = new PX(target(v), hostFacing(v));
    m(toHost, wmSet, v, p);
    m(hostToVmObj, wmSet, p, v);
    return p;
  }
  function unwrapArgs(args) {
    const out = [];
    for (let i = 0; i < args.length; i++) defineProperty(out, i, { __proto__: null, value: unwrap(args[i]), writable: true, enumerable: true, configurable: true });
    return out;
  }
  function hostFacing(v) {
    return {
      __proto__: null,
      get(_t, key) {
        if (denied(key)) return undefined;
        try { return unwrap(rGet(v, key)); } catch (e) { throw vmErrorToHost(e); }
      },
      set(_t, key, value) {
        if (denied(key)) return false;
        try { return rSet(v, key, wrap(value)); } catch (e) { throw vmErrorToHost(e); }
      },
      has(_t, key) {
        if (denied(key)) return false;
        try { return rHas(v, key); } catch (e) { throw vmErrorToHost(e); }
      },
      ownKeys(t) {
        let keys;
        try { keys = rOwnKeys(v); } catch (e) { throw vmErrorToHost(e); }
        const out = [];
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          if (!denied(k) || rGetOwn(t, k)) defineProperty(out, out.length, { __proto__: null, value: k, writable: true, enumerable: true, configurable: true });
        }
        return out;
      },
      getOwnPropertyDescriptor(t, key) {
        if (denied(key)) return rGetOwn(t, key);
        let d;
        try { d = rGetOwn(v, key); } catch (e) { throw vmErrorToHost(e); }
        if (d === undefined) return undefined;
        const fixed = rGetOwn(t, key);
        const nonConfigurable = fixed !== undefined && fixed.configurable === false;
        let value;
        try { value = unwrap(rGet(v, key)); } catch (e) { throw vmErrorToHost(e); }
        return { __proto__: null, value, writable: nonConfigurable ? fixed.writable : true, enumerable: d.enumerable, configurable: !nonConfigurable };
      },
      defineProperty() { return false; },
      deleteProperty() { return false; },
      getPrototypeOf() { return null; },
      setPrototypeOf() { return false; },
      preventExtensions() { return false; },
      apply(_t, thisArg, args) {
        let result;
        try { result = apply(v, wrap(thisArg), wrapArgs(args)); } catch (e) { throw vmErrorToHost(e); }
        return unwrap(result);
      },
      construct() { throw makeHostError('generated code cannot be constructed', 'TypeError'); },
    };
  }

  return { __proto__: null, toHost: unwrap };
})
`;

/** Deep-freezes every built-in reachable from the realm's global object (run once, before any generated code). */
const FREEZE = String.raw`
(function () {
  'use strict';
  // V8 adds an inspector-only console to every context; generated code has no use for it.
  delete globalThis.console;
  Object.defineProperty(Error, 'prepareStackTrace', { value: undefined, writable: false, enumerable: false, configurable: false });
  const seen = new WeakSet();
  const stack = [globalThis];
  while (stack.length > 0) {
    const o = stack.pop();
    if (o === null || (typeof o !== 'object' && typeof o !== 'function') || seen.has(o)) continue;
    seen.add(o);
    Object.freeze(o);
    for (const key of Reflect.ownKeys(o)) {
      const d = Reflect.getOwnPropertyDescriptor(o, key);
      if (d === undefined) continue;
      if ('value' in d) stack.push(d.value);
      else stack.push(d.get, d.set);
    }
    stack.push(Object.getPrototypeOf(o));
  }
})
`;

interface Membrane {
  /** A vm value as the host may use it (functions callable with host arguments). */
  toHost(value: unknown): unknown;
}

export interface VmRealm {
  readonly context: Context;
  readonly membrane: Membrane;
}

const HOST_ERRORS: Record<string, ErrorConstructor> = { TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError };

const makeHostError = (message: string, name: string): Error => {
  const err = new (HOST_ERRORS[name] ?? Error)(message);
  if (HOST_ERRORS[name]) return err;
  if (name !== 'Error') Object.defineProperty(err, 'name', { value: name, writable: true, enumerable: false, configurable: true });
  return err;
};

/** A fresh, frozen realm with its membrane. One per worker is enough (generated code cannot change it). */
export function createVmRealm(): VmRealm {
  const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
    name: 'quant-sim generated code',
    codeGeneration: { strings: false, wasm: false },
  });
  const createMembrane = new vm.Script(MEMBRANE, { filename: 'quant-sim-membrane.js' }).runInContext(context) as (mk: typeof makeHostError) => Membrane;
  const membrane = createMembrane(makeHostError);
  (new vm.Script(FREEZE, { filename: 'quant-sim-freeze.js' }).runInContext(context) as () => void)();
  return { context, membrane };
}

/** A FactoryLoader compiling generated code in `realm` (default: one realm shared by every call of this loader). */
export function createVmLoader(realm: VmRealm = createVmRealm()): FactoryLoader {
  return (params, body) => {
    const fn = vm.compileFunction(body, [...params], { parsingContext: realm.context, filename: 'generated-strategy.js' });
    return realm.membrane.toHost(fn) as (...args: unknown[]) => unknown;
  };
}
