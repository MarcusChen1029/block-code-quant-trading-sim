/**
 * localStorage that never throws: private windows, blocked site data or a full quota just mean
 * "nothing stored" / "not saved". Returns false when a write did not stick.
 */
export function loadJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

export function saveJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadText(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function saveText(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Everything this app keeps in localStorage starts with this. */
export const OWN_KEY_PREFIX = 'quant-sim.';

/** Removes every key the app saved (blocks, settings, layout, theme…); returns how many. Never throws. */
export function clearOwnData(storage: Pick<Storage, 'length' | 'key' | 'removeItem'> = localStorage): number {
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(OWN_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
    return keys.length;
  } catch {
    return 0;
  }
}
