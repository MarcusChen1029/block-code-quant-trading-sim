import { describe, expect, it } from 'vitest';
import { GLOSSARY } from './helpContent';
import { matchesGlossary } from './helpDialog';

describe('word list search', () => {
  const drawdown = GLOSSARY.find((g) => g.term === 'Drawdown')!;

  it('an empty search shows everything', () => {
    for (const g of GLOSSARY) expect(matchesGlossary(g, '')).toBe(true);
    expect(matchesGlossary(drawdown, '   ')).toBe(true);
  });

  it('matches the term or the explanation, ignoring case and spaces around the search', () => {
    expect(matchesGlossary(drawdown, ' DRAW ')).toBe(true);
    expect(matchesGlossary(drawdown, 'highest point')).toBe(true);
    expect(matchesGlossary(drawdown, 'leverage')).toBe(false);
  });

  it('finds something for every word a beginner might look up', () => {
    for (const word of ['loan', 'fee', 'average', 'profit', 'risk', 'wipe']) expect(GLOSSARY.some((g) => matchesGlossary(g, word)), word).toBe(true);
  });
});
