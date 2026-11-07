/**
 * Flesch-Kincaid grade level, so the readability rule has teeth.
 *
 * The plan is blunt about this: a readability check that is not computed and
 * enforced is theatre. Prose aimed at someone deciding whether to run an
 * automation should not read like a standards document, and the accepted
 * ceiling is grade 9.
 *
 *   grade = 0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59
 *
 * Syllable counting is a heuristic — English has no closed-form rule — so this
 * is deliberately used only as a threshold on long passages, where per-word
 * error averages out, and never as a precise score shown to anyone.
 */

/** Sentence terminators, including the ellipsis a model likes to emit. */
const SENTENCE_BREAK = /[.!?]+(?:\s|$)/g;

const VOWEL_GROUP = /[aeiouy]+/g;

/**
 * Counts syllables in one word.
 *
 * Vowel groups approximate syllables well; the two corrections that matter are
 * a silent trailing `e` (`nine` is one syllable, not two) and the floor of one,
 * since every written word is pronounced.
 */
export function countSyllables(word: string): number {
  const cleaned = word.toLowerCase().replace(/[^a-z]/g, '');
  if (cleaned.length === 0) return 0;

  const groups = cleaned.match(VOWEL_GROUP)?.length ?? 0;
  const silentTrailingE = cleaned.endsWith('e') && !cleaned.endsWith('le') && groups > 1;
  return Math.max(1, groups - (silentTrailingE ? 1 : 0));
}

export type ReadabilityScore = {
  grade: number;
  words: number;
  sentences: number;
  syllables: number;
};

/**
 * Returns the grade level plus the counts behind it, so a rejection can say why
 * rather than only that. A text with no words scores 0 rather than dividing by
 * zero; the length gates reject empty prose long before this runs.
 */
export function readability(text: string): ReadabilityScore {
  const words = text.split(/\s+/).filter((word) => /[a-z]/i.test(word));
  const sentences = Math.max(1, (text.match(SENTENCE_BREAK) ?? []).length);

  if (words.length === 0) {
    return { grade: 0, words: 0, sentences, syllables: 0 };
  }

  const syllables = words.reduce((total, word) => total + countSyllables(word), 0);
  const grade =
    0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59;

  return {
    // One decimal place: the heuristic does not support more precision, and a
    // stable rounded value keeps output byte-identical across runs.
    grade: Math.round(grade * 10) / 10,
    words: words.length,
    sentences,
    syllables,
  };
}

/** The accepted ceiling. Above this, prose is rejected rather than published. */
export const MAX_GRADE = 9;

export function isReadable(text: string, maxGrade = MAX_GRADE): boolean {
  return readability(text).grade <= maxGrade;
}
