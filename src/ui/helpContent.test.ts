import { describe, expect, it } from 'vitest';
import { searchGlossary } from './help';
import { GLOSSARY } from './helpContent';

describe('help word list', () => {
  it('has unique terms with text', () => {
    const terms = GLOSSARY.map((e) => e.term.toLowerCase());
    expect(new Set(terms).size).toBe(terms.length);
    for (const e of GLOSSARY) expect(e.text.length).toBeGreaterThan(20);
  });

  it('finds a word by its other names, best match first', () => {
    expect(searchGlossary(GLOSSARY, 'timeframe')[0].term).toBe('Candle size');
    expect(searchGlossary(GLOSSARY, 'BAR')[0].term).toBe('Candle');
    expect(searchGlossary(GLOSSARY, 'sharpe')[0].term).toBe('Sharpe ratio');
  });

  it('returns everything for an empty search and nothing for nonsense', () => {
    expect(searchGlossary(GLOSSARY, '  ')).toHaveLength(GLOSSARY.length);
    expect(searchGlossary(GLOSSARY, 'zzqx')).toEqual([]);
  });
});
