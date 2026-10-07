import { defaultRawSettings, type RawSettings } from './settings';

export type AccountFields = Pick<RawSettings, 'leverage' | 'takerFeePct' | 'makerFeePct' | 'slippageBps'>;

export interface AccountSummary {
  /** e.g. "Leverage 1x · fees 0.04%/0.02% · slippage 2 bps" */
  text: string;
  /** True when any value differs from the defaults (the closed section is then highlighted). */
  nonDefault: boolean;
}

const DEFAULTS: AccountFields = defaultRawSettings(0);
const KEYS: ReadonlyArray<keyof AccountFields> = ['leverage', 'takerFeePct', 'makerFeePct', 'slippageBps'];

const shown = (value: string) => (value.trim() === '' ? '?' : value.trim());
const same = (a: string, b: string) => a.trim() !== '' && Number(a) === Number(b);

/**
 * One-line summary of the collapsed "Account settings" section, built from the values exactly as typed.
 * `builtInStrategy`: the run uses the built-in SMA cross instead of the blocks (also a non-default choice).
 */
export function accountSummary(fields: AccountFields, builtInStrategy = false): AccountSummary {
  const parts = [
    `Leverage ${shown(fields.leverage)}x`,
    `fees ${shown(fields.takerFeePct)}%/${shown(fields.makerFeePct)}%`,
    `slippage ${shown(fields.slippageBps)} bps`,
  ];
  if (builtInStrategy) parts.push('runs the built-in SMA cross');
  const changed = KEYS.some((k) => !same(fields[k], DEFAULTS[k]));
  return { text: parts.join(' · '), nonDefault: changed || builtInStrategy };
}
