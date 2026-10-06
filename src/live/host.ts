import { CompileError, compileBlocks } from '../blocks/compiler';
import type { IndicatorUse } from '../blocks/generator';
import type { MarketDataAdapter } from '../data/adapter';
import type { Candle } from '../data/types';
import { StrategyError, type Strategy } from '../engine/strategy';
import { buildStrategy } from '../worker/protocol';
import { LiveRunner, type HaltInfo, type LiveStatus, type RunnerOptions } from './runner';
import { snapshotToSpec, type LiveSessionRecord } from './session';
import { SessionEngine, type SessionDelta } from './sessionEngine';

/** Page -> live worker. */
export type LiveCommand =
  /** 'live': resume/catch up and follow the stream. 'replay': rebuild a stopped session up to its last bar. */
  | { type: 'start'; session: LiveSessionRecord; mode: 'live' | 'replay' }
  | { type: 'stop' }
  /** The page became visible again / came back online: re-check for bars that closed meanwhile. */
  | { type: 'resync' };

/** Live worker -> page. */
export type LiveEvent =
  /** Indicators used by the session's own block snapshot (chart overlays). */
  | { type: 'program'; indicators: IndicatorUse[] }
  | { type: 'delta'; delta: SessionDelta }
  | { type: 'tick'; candle: Candle; markEquity: number; closed: boolean }
  | { type: 'status'; status: LiveStatus }
  | { type: 'halt'; halt: HaltInfo };

export type RunnerTuning = Omit<RunnerOptions, 'mode' | 'symbol' | 'timeframe'>;

export interface LiveHost {
  handle(command: LiveCommand): void;
  /** Tests: resolves when the runner has no work in flight. */
  idle(): Promise<void>;
}

/**
 * One live session per worker: builds the strategy from the session's SNAPSHOT (Pine sources included, synced
 * into this worker's own registry, so the editor's later changes never matter), then runs it. The worker file is
 * only glue around this.
 */
export function createLiveHost(post: (event: LiveEvent) => void, adapter: MarketDataAdapter, tuning: RunnerTuning = {}): LiveHost {
  let runner: LiveRunner | null = null;

  const start = (session: LiveSessionRecord, mode: 'live' | 'replay') => {
    runner?.stop();
    let strategy: Strategy;
    try {
      strategy = buildStrategy(snapshotToSpec(session.strategy));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const blockId = err instanceof StrategyError || err instanceof CompileError ? err.blockId : undefined;
      const halt: HaltInfo = { reason: 'error', message: `strategy cannot start: ${message}`, lastBarTime: session.lastBarTime };
      if (blockId !== undefined) halt.blockId = blockId;
      post({ type: 'halt', halt });
      return;
    }
    if (session.strategy.kind === 'blocks') {
      const compiled = compileBlocks(session.strategy.workspace); // registry already holds the snapshot's Pine scripts
      if (compiled.ok) post({ type: 'program', indicators: compiled.program.indicators });
    }
    const engine = new SessionEngine(session, strategy, mode === 'replay' ? (session.lastBarTime ?? -Infinity) : undefined);
    runner = new LiveRunner(
      engine,
      adapter,
      {
        delta: (delta) => post({ type: 'delta', delta }),
        tick: (candle, markEquity, closed) => post({ type: 'tick', candle, markEquity, closed }),
        status: (status) => post({ type: 'status', status }),
        halt: (halt) => post({ type: 'halt', halt }),
      },
      { ...tuning, mode, symbol: session.symbol, timeframe: session.timeframe },
    );
    runner.start();
  };

  return {
    handle(command) {
      switch (command.type) {
        case 'start':
          start(command.session, command.mode);
          break;
        case 'stop':
          runner?.stop();
          break;
        case 'resync':
          runner?.resync();
          break;
      }
    },
    async idle() {
      await runner?.idle();
    },
  };
}
