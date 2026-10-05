import { afterEach, describe, it, expect } from 'vitest';
import { compileBlocks } from '../blocks/compiler';
import { getIndicator } from '../blocks/registry';
import { indicator, log, workspace } from '../blocks/testing';
import { syntheticCandles } from '../engine/syntheticCandles';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { handleRequest } from '../worker/protocol';
import { syncPineIndicators } from './library';

const UNBOUNDED_LENGTH = `//@version=5
indicator("Smooth")
len = input.int(14, "Length")
plot(ta.sma(close, len), "v")
`;
const SCALED_LENGTH = `//@version=5
indicator("Scaled")
len = input.int(14, "Length", minval=1, maxval=100)
plot(ta.sma(close, len * 100), "v")
`;
const run = (ws: unknown, pineScripts: { id: string; source: string }[]) => handleRequest({
  type: 'run', candles: syntheticCandles(50), config: { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG },
  strategy: { id: 'blocks', workspace: ws, pineScripts },
});

afterEach(() => {
  syncPineIndicators([]);
});

describe('indicator parameters that cannot work are reported against their block', () => {
  it('an input used as a ta.* length gets the valid range 1..5000, so a huge field value is a block compile error', () => {
    syncPineIndicators([{ id: 'pine_smooth', source: UNBOUNDED_LENGTH }]);
    expect(getIndicator('pine_smooth')!.params[0]).toMatchObject({ name: 'len', min: 1, max: 5000, integer: true });
    const block = indicator('pine_smooth', { LEN: 1e9 });
    const result = compileBlocks(workspace({ onBar: [log(block)] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toEqual({ message: 'Smooth Length must be a whole number from 1 to 5000', blockId: block.id });
  });

  it('an instance that fails when the run starts (length out of range at runtime) names the indicator block', () => {
    const block = indicator('pine_scaled', { LEN: 60 }); // 60 * 100 = 6000 > 5000
    const response = run(workspace({ onBar: [log(block)] }), [{ id: 'pine_scaled', source: SCALED_LENGTH }]);
    expect(response).toEqual({
      type: 'error',
      message: 'Pine script "Scaled", line 4: ta.sma length must be a whole number from 1 to 5000, got 6000',
      blockId: block.id,
    });
  });

  it('built-in indicator instances are attributed to their block too', () => {
    const ok = indicator('sma', { LENGTH: 20 });
    const response = run(workspace({ onBar: [log(ok)] }), []);
    expect(response.type).toBe('result');
  });
});
