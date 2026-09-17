/**
 * Corpus distinctness and coverage audit (B-4-5a).
 *
 * The audit exists to make corpus PADDING fail loudly, so these tests are mostly about proving it
 * actually catches the padding shapes rather than merely running: a renamed-character copy, a
 * punctuation-only reskin, an identical pair inside one set, a trivial stub. A validator that passed
 * those would be worse than none, because it would license the exact expansion it was written to prevent.
 *
 * It also pins the honest limit: `proves_literary_diversity` is `false` in the artifact. A surface
 * similarity score cannot establish that two passages test different craft.
 *
 * Runs against the real accepted corpus, so the threshold is validated against authored prose rather
 * than only against synthetic fixtures. No credentials, no provider, no network.
 */
import { describe, expect, it } from 'vitest';
import {
  auditCoverage,
  auditDistinctness,
  NEAR_DUPLICATE_THRESHOLD,
  normalizeForComparison,
  similarity,
} from './distinctness.js';
import { loadCorpus, VARIANT_CLASSES, type ContrastSet } from './corpus.js';

const corpus = loadCorpus();

/** A synthetic set shaped like a real one, for the negative cases. */
function makeSet(id: string, body: string): ContrastSet {
  const variants = Object.fromEntries(
    VARIANT_CLASSES.map((c) => [
      c,
      `${body} This is the ${c} rendering of the passage under test.`,
    ]),
  ) as ContrastSet['variants'];
  return {
    id,
    genre: 'academy',
    function: 'hook',
    variants,
    expected: {
      prose_rank: [...VARIANT_CLASSES],
      structure_rank: [...VARIANT_CLASSES],
      min_gap_prose_vs_translation_like: 40,
      min_gap_structure_vs_western_english: 35,
    },
  };
}

describe('similarity is deterministic, explainable and normalization-aware', () => {
  it('is 1 for identical text and 0 for text sharing no trigram', () => {
    expect(similarity('the gate opened', 'the gate opened')).toBe(1);
    expect(similarity('aaaaaa', 'bbbbbb')).toBe(0);
  });

  it('ignores case, whitespace and punctuation differences', () => {
    // A reskin that only changes punctuation must not read as a different passage.
    expect(similarity('He smiled.', 'he   smiled!!')).toBeCloseTo(1, 10);
  });

  it('is symmetric and stable across repeated runs', () => {
    const a = 'The measurement device screamed and the letters came up red.';
    const b = 'The measuring device shrieked and the letters showed red.';
    expect(similarity(a, b)).toBeCloseTo(similarity(b, a), 12);
    expect(similarity(a, b)).toBe(similarity(a, b));
  });

  it('normalizes without mutating the stored prose', () => {
    const original = 'Red letters.  The  same  red letters!';
    expect(normalizeForComparison(original)).toBe('red letters the same red letters');
    expect(original).toBe('Red letters.  The  same  red letters!');
  });
});

describe('the accepted 40-set corpus passes its own audit', () => {
  const report = auditDistinctness(corpus.sets);

  it('reports no structural finding and no near-duplicate', () => {
    expect(report.structural).toEqual([]);
    expect(report.nearDuplicates).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('compared every same-class pair of sets', () => {
    // 40 sets → 780 pairs × 5 classes.
    expect(report.setCount).toBe(40);
    expect(report.comparisons).toBe(((40 * 39) / 2) * VARIANT_CLASSES.length);
  });

  it('leaves real headroom under the threshold, so the gate is not borderline', () => {
    // If the authored corpus sat just under the threshold, the gate would be luck rather than margin.
    expect(report.maxObserved).not.toBeNull();
    expect(report.maxObserved?.score).toBeLessThan(NEAR_DUPLICATE_THRESHOLD * 0.75);
  });

  it('states that it does not prove literary diversity', () => {
    expect(report.proves_literary_diversity).toBe(false);
    expect(report.method).toBe('character_trigram_jaccard');
    expect(report.threshold).toBe(NEAR_DUPLICATE_THRESHOLD);
  });
});

describe('the audit catches the ways a corpus gets padded', () => {
  it('flags a renamed-character copy of an existing set', () => {
    const [original] = corpus.sets;
    if (original === undefined) throw new Error('the accepted corpus is empty');
    const renamed: ContrastSet = {
      ...original,
      id: 'cs-fake-rename',
      variants: Object.fromEntries(
        Object.entries(original.variants).map(([k, v]) => [
          k,
          v.replace(/Do-yoon/g, 'Min-jun').replace(/Gangnam/g, 'Hongdae'),
        ]),
      ) as ContrastSet['variants'],
    };
    const report = auditDistinctness([original, renamed]);
    expect(report.passed).toBe(false);
    const finding = report.nearDuplicates[0];
    expect(finding?.id).toBe('near_duplicate_variant');
    expect([finding?.setA, finding?.setB]).toContain('cs-fake-rename');
    // The finding must carry evidence a human can act on, not just a number.
    expect(finding?.score).toBeGreaterThanOrEqual(NEAR_DUPLICATE_THRESHOLD);
    expect((finding?.evidence ?? '').length).toBeGreaterThan(10);
  });

  it('flags a punctuation-and-case reskin', () => {
    const base = makeSet(
      'cs-fake-a',
      'The corridor lights failed one row at a time, and nobody moved.',
    );
    const reskin: ContrastSet = {
      ...base,
      id: 'cs-fake-b',
      variants: Object.fromEntries(
        Object.entries(base.variants).map(([k, v]) => [k, v.toUpperCase().replace(/,/g, ';')]),
      ) as ContrastSet['variants'],
    };
    expect(auditDistinctness([base, reskin]).passed).toBe(false);
  });

  it('flags a duplicate set id', () => {
    const a = makeSet(
      'cs-dup',
      'A bell rang somewhere below the training hall and the queue shuffled.',
    );
    const b = makeSet(
      'cs-dup',
      'Entirely different content about a market street at dusk in autumn.',
    );
    const report = auditDistinctness([a, b]);
    expect(report.structural.map((f) => f.id)).toContain('duplicate_set_id');
  });

  it('flags an identical variant pair inside one set, which discriminates nothing', () => {
    const set = makeSet(
      'cs-same',
      'Twin passages that do not differ cannot demonstrate a ranking.',
    );
    const broken: ContrastSet = {
      ...set,
      variants: { ...set.variants, translation_like: set.variants.kwn_english },
    };
    const report = auditDistinctness([broken]);
    expect(report.structural.map((f) => f.id)).toContain('identical_variant_pair_within_set');
  });

  it('flags an empty or trivial variant', () => {
    const set = makeSet(
      'cs-thin',
      'Adequate length for the remaining classes in this fixture set.',
    );
    const thin: ContrastSet = {
      ...set,
      variants: { ...set.variants, literary: 'Too short.', weak_serial: '   ' },
    };
    const ids = auditDistinctness([thin]).structural.map((f) => f.id);
    expect(ids).toContain('trivial_variant');
    expect(ids).toContain('empty_variant');
  });

  it('flags an expected rank that omits a variant class it ships', () => {
    const set = makeSet('cs-rank', 'A ranking that names four of five classes hides the fifth.');
    const broken: ContrastSet = {
      ...set,
      expected: { ...set.expected, prose_rank: ['kwn_english', 'western_english'] },
    };
    const report = auditDistinctness([broken]);
    expect(report.structural.map((f) => f.id)).toContain('rank_missing_variant_class');
  });

  it('accepts two genuinely different passages of the same genre and function', () => {
    // The threshold must not reject legitimate additions, or it would block the expansion it guards.
    const a = makeSet(
      'cs-ok-a',
      'The measurement hall smelled of ozone and cheap floor wax that morning.',
    );
    const b = makeSet(
      'cs-ok-b',
      'Rain hammered the loading dock while the courier argued about a seal.',
    );
    expect(auditDistinctness([a, b]).passed).toBe(true);
  });
});

describe('coverage audit reports what the corpus actually spans', () => {
  const coverage = auditCoverage(corpus.sets);

  it('counts the accepted corpus across its genres and functions', () => {
    expect(Object.values(coverage.byGenre).reduce((a, b) => a + b, 0)).toBe(40);
    expect(Object.values(coverage.byFunction).reduce((a, b) => a + b, 0)).toBe(40);
    expect(Object.keys(coverage.byFunction)).toHaveLength(8);
  });

  it('shows no genre starved relative to the others', () => {
    expect(coverage.concentrated).toEqual([]);
  });

  it('evidences dimension coverage through the lint codes the corpus expects', () => {
    // 38 distinct codes across the translation-like, structural and English-prose families.
    expect(coverage.lintCodes.length).toBeGreaterThanOrEqual(30);
    expect(coverage.lintCodes.some((c) => c.startsWith('TRN-'))).toBe(true);
    expect(coverage.lintCodes.some((c) => c.startsWith('ST-'))).toBe(true);
    expect(coverage.lintCodes.some((c) => c.startsWith('EP-'))).toBe(true);
  });

  it('reports concentration when additions pile into one genre', () => {
    const skewed = [
      ...Array.from({ length: 10 }, (_, i) => ({
        ...makeSet(
          `cs-skew-${String(i)}`,
          `Passage number ${String(i)} set in a very specific academy corridor.`,
        ),
        genre: 'academy',
      })),
      {
        ...makeSet('cs-skew-x', 'A single lonely regression passage about a returning loop.'),
        genre: 'regression',
      },
    ] as ContrastSet[];
    expect(auditCoverage(skewed).concentrated).toContain('regression');
  });
});
