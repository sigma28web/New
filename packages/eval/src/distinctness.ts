/**
 * Deterministic corpus distinctness and coverage audit (B-4-5a).
 *
 * WHY THIS EXISTS. Expanding the contrast corpus is the one B-4-5 task that can be done without human
 * reviewers, and it is also the one most easily faked: 60 near-duplicates with renamed characters would
 * reach a count of 100 while making the corpus WORSE, because agreement would then be measured over
 * sixty restatements of the same discrimination. This module is the gate that makes padding fail loudly
 * instead of passing quietly, so a future expansion is safe to attempt incrementally.
 *
 * It is a REVIEW AID, not a proof of literary diversity. A similarity score below a threshold means two
 * passages do not share surface form; it says nothing about whether they test different craft. The audit
 * says so in its own output rather than letting a green check imply more than it measured.
 *
 * DETERMINISM AND EXPLAINABILITY. Similarity is character-trigram Jaccard over normalized text: stable
 * across runs and platforms, cheap enough for the full O(n²) pairing at corpus scale, and explainable —
 * a failure reports the two ids, the score and the shared-trigram evidence, so a human can judge the pair
 * rather than being told a number. No embeddings, no model call, no network.
 */
import type { ContrastSet, VariantClass } from './corpus.js';
import { VARIANT_CLASSES } from './corpus.js';

/**
 * Similarity at or above which a pair is reported for human judgement.
 *
 * Chosen conservatively and empirically against the accepted 40-set corpus: the highest same-class
 * similarity between two DIFFERENT sets there is well below this, while a renamed-character copy of an
 * existing passage scores far above it. A conservative threshold means the audit flags for review rather
 * than deleting, which is the correct balance for authored prose — the tool never rewrites a set.
 */
export const NEAR_DUPLICATE_THRESHOLD = 0.6;

/** Trigram size. Three characters is small enough to survive paraphrase and large enough to be specific. */
const NGRAM = 3;

/**
 * Normalize for comparison only: case, whitespace and punctuation folded away.
 *
 * The stored prose is never altered — normalization exists so that "He smiled." and "he  smiled!" are not
 * treated as different text by an audit whose job is to catch reuse.
 */
export function normalizeForComparison(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trigrams(text: string): Set<string> {
  const normalized = normalizeForComparison(text);
  const out = new Set<string>();
  for (let i = 0; i + NGRAM <= normalized.length; i += 1) out.add(normalized.slice(i, i + NGRAM));
  return out;
}

/** Jaccard overlap of character trigrams: 1 for identical normalized text, 0 for no shared trigram. */
export function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const g of ta) if (tb.has(g)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

export interface DistinctnessFinding {
  /** Machine-readable reason, e.g. `near_duplicate_variant`. No prose. */
  readonly id: string;
  readonly setA: string;
  readonly setB: string;
  readonly variant: VariantClass;
  readonly score: number;
  /** A short shared fragment, so a reviewer sees WHY the pair was flagged. */
  readonly evidence: string;
}

export interface StructuralFinding {
  readonly id: string;
  readonly detail: string;
}

export interface DistinctnessReport {
  readonly setCount: number;
  readonly comparisons: number;
  readonly threshold: number;
  readonly method: 'character_trigram_jaccard';
  readonly nearDuplicates: readonly DistinctnessFinding[];
  readonly structural: readonly StructuralFinding[];
  /** Highest same-class similarity observed between two different sets, with the pair that produced it. */
  readonly maxObserved: {
    readonly score: number;
    readonly setA: string;
    readonly setB: string;
  } | null;
  readonly passed: boolean;
  /**
   * Stated in the artifact itself: a surface-similarity audit cannot establish that two passages test
   * different craft, so a green report is a necessary condition for corpus quality and never a sufficient
   * one.
   */
  readonly proves_literary_diversity: false;
}

function sharedFragment(a: string, b: string): string {
  // The longest shared run of normalized words, capped — enough to recognize reuse, short enough to keep
  // manuscript prose out of a published report.
  const wa = normalizeForComparison(a).split(' ');
  const nb = ` ${normalizeForComparison(b)} `;
  let best = '';
  for (let i = 0; i < wa.length; i += 1) {
    let run = '';
    for (let j = i; j < wa.length; j += 1) {
      const word = wa[j] ?? '';
      const next = run === '' ? word : `${run} ${word}`;
      if (!nb.includes(` ${next} `)) break;
      run = next;
      if (run.length > best.length) best = run;
      if (best.length >= 60) return best.slice(0, 60);
    }
  }
  return best.slice(0, 60);
}

/**
 * Audit a corpus for structural integrity and surface reuse.
 *
 * Structural checks fail closed on the ways a corpus can be malformed or self-defeating: a duplicate id,
 * an empty or trivial variant, a missing variant class, an identical pair of variants inside one set (a
 * contrast set whose two sides are the same text discriminates nothing), or a set whose expected ranking
 * does not name every class it ships.
 *
 * Near-duplicate checks compare the SAME variant class across every pair of sets, because that is where
 * padding shows up: a new set built by renaming characters in an existing one produces a `kwn_english`
 * passage nearly identical to that set's `kwn_english`.
 */
export function auditDistinctness(
  sets: readonly ContrastSet[],
  options: { readonly threshold?: number } = {},
): DistinctnessReport {
  const threshold = options.threshold ?? NEAR_DUPLICATE_THRESHOLD;
  const structural: StructuralFinding[] = [];
  const nearDuplicates: DistinctnessFinding[] = [];

  const seenIds = new Set<string>();
  for (const set of sets) {
    if (seenIds.has(set.id)) structural.push({ id: 'duplicate_set_id', detail: set.id });
    seenIds.add(set.id);

    for (const cls of VARIANT_CLASSES) {
      const text = set.variants[cls];
      if (typeof text !== 'string' || normalizeForComparison(text).length === 0) {
        structural.push({ id: 'empty_variant', detail: `${set.id}:${cls}` });
        continue;
      }
      // A variant too short to exhibit hook, cadence or paragraphing cannot test what it claims to.
      if (normalizeForComparison(text).split(' ').length < 12)
        structural.push({ id: 'trivial_variant', detail: `${set.id}:${cls}` });
    }

    // Two identical sides inside one set would make its expected ranking unprovable.
    for (let i = 0; i < VARIANT_CLASSES.length; i += 1) {
      for (let j = i + 1; j < VARIANT_CLASSES.length; j += 1) {
        const a = VARIANT_CLASSES[i];
        const b = VARIANT_CLASSES[j];
        if (!a || !b) continue;
        const ta = set.variants[a];
        const tb = set.variants[b];
        if (typeof ta !== 'string' || typeof tb !== 'string') continue;
        if (normalizeForComparison(ta) === normalizeForComparison(tb))
          structural.push({
            id: 'identical_variant_pair_within_set',
            detail: `${set.id}:${a}|${b}`,
          });
      }
    }

    // The expected ranks are what the fixture derivation reads; a rank missing a class it ships would
    // silently place that class at the bottom.
    for (const [label, rank] of [
      ['prose_rank', set.expected.prose_rank],
      ['structure_rank', set.expected.structure_rank],
    ] as const) {
      const missing = VARIANT_CLASSES.filter((c) => !rank.includes(c));
      if (missing.length > 0)
        structural.push({
          id: 'rank_missing_variant_class',
          detail: `${set.id}:${label}:${missing.join(',')}`,
        });
    }
  }

  let comparisons = 0;
  let maxObserved: DistinctnessReport['maxObserved'] = null;
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const a = sets[i];
      const b = sets[j];
      if (!a || !b) continue;
      for (const cls of VARIANT_CLASSES) {
        const ta = a.variants[cls];
        const tb = b.variants[cls];
        if (typeof ta !== 'string' || typeof tb !== 'string') continue;
        comparisons += 1;
        const score = similarity(ta, tb);
        if (maxObserved === null || score > maxObserved.score)
          maxObserved = { score, setA: a.id, setB: b.id };
        if (score >= threshold)
          nearDuplicates.push({
            id: 'near_duplicate_variant',
            setA: a.id,
            setB: b.id,
            variant: cls,
            score: Math.round(score * 1000) / 1000,
            evidence: sharedFragment(ta, tb),
          });
      }
    }
  }

  return {
    setCount: sets.length,
    comparisons,
    threshold,
    method: 'character_trigram_jaccard',
    nearDuplicates,
    structural,
    maxObserved,
    passed: nearDuplicates.length === 0 && structural.length === 0,
    proves_literary_diversity: false,
  };
}

export interface CoverageReport {
  readonly byGenre: Readonly<Record<string, number>>;
  readonly byFunction: Readonly<Record<string, number>>;
  /** Lint codes the corpus expects at least once, which is how dimension coverage is evidenced. */
  readonly lintCodes: readonly string[];
  readonly genreFunctionPairs: number;
  /** Genres carrying fewer sets than the largest genre by more than this ratio are reported. */
  readonly concentrated: readonly string[];
}

/**
 * Summarize what the corpus actually covers.
 *
 * Reported rather than asserted here: a threshold on "enough coverage" belongs to the suite that consumes
 * this, so the same summary can back both a soft report and a hard gate without duplicating the counting.
 */
export function auditCoverage(sets: readonly ContrastSet[]): CoverageReport {
  const byGenre: Record<string, number> = {};
  const byFunction: Record<string, number> = {};
  const lintCodes = new Set<string>();
  const pairs = new Set<string>();

  for (const set of sets) {
    byGenre[set.genre] = (byGenre[set.genre] ?? 0) + 1;
    byFunction[set.function] = (byFunction[set.function] ?? 0) + 1;
    pairs.add(`${set.genre}|${set.function}`);
    for (const [key, value] of Object.entries(set.expected)) {
      if (key.startsWith('lint_') && Array.isArray(value))
        for (const code of value) lintCodes.add(String(code));
    }
  }

  const counts = Object.values(byGenre);
  const max = counts.length > 0 ? Math.max(...counts) : 0;
  // A genre holding less than half the largest genre's share means additions concentrated elsewhere.
  const concentrated = Object.entries(byGenre)
    .filter(([, n]) => max > 0 && n * 2 < max)
    .map(([genre]) => genre)
    .sort();

  return {
    byGenre,
    byFunction,
    lintCodes: [...lintCodes].sort(),
    genreFunctionPairs: pairs.size,
    concentrated,
  };
}
