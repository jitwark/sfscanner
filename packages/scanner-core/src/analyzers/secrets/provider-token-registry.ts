import {
  PROVIDER_TOKEN_PATTERNS,
  classifierPattern,
  type ProviderTokenPattern,
} from '../../provider-token-patterns';

const MAX_PROVIDER_TOKEN_CHARS = 4_096;
const wrapperPattern = /^(?:<([^>\r\n]{1,512})>|\[([^\]\r\n]{1,512})\])$/;

export type ProviderTokenClassification = Readonly<{ kind: string }>;
export type ProviderTokenGrammar = Readonly<ProviderTokenPattern>;

function freezeGrammar(entry: ProviderTokenPattern): ProviderTokenGrammar {
  return Object.freeze({
    ...entry,
    surfaces: Object.freeze([...entry.surfaces]),
    provenance: Object.freeze({ ...entry.provenance }),
    canary: Object.freeze({ ...entry.canary }),
  });
}

/** Reviewed provider grammars. SecureFlow's own key remains redaction-only by policy. */
export const PROVIDER_TOKEN_GRAMMARS_V2 = Object.freeze(
  PROVIDER_TOKEN_PATTERNS.map(freezeGrammar),
);

const classifiedGrammars = PROVIDER_TOKEN_GRAMMARS_V2
  .filter((entry) => entry.surfaces.includes('classify'))
  .map((entry) => ({ kind: entry.kind, pattern: classifierPattern(entry) }));

/** Return a provider label only when the entire value (or one reviewed wrapper) matches. */
export function classifyProviderToken(value: unknown): ProviderTokenClassification | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > MAX_PROVIDER_TOKEN_CHARS) return undefined;

  const direct = matchClassifiedGrammar(candidate);
  if (direct) return Object.freeze({ kind: direct });

  const wrapper = wrapperPattern.exec(candidate);
  if (!wrapper) return undefined;
  const inner = (wrapper[1] ?? wrapper[2]).trim();
  const wrapped = matchClassifiedGrammar(inner);
  return wrapped ? Object.freeze({ kind: wrapped }) : undefined;
}

function matchClassifiedGrammar(value: string): string | undefined {
  let matched: string | undefined;
  for (const grammar of classifiedGrammars) {
    if (!grammar.pattern.test(value)) continue;
    if (matched !== undefined) return undefined;
    matched = grammar.kind;
  }
  return matched;
}
