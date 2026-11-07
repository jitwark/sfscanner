export type RegexExperimentDecision = 'GO' | 'NO_GO';

export function evaluateRegexExperiment(): RegexExperimentDecision {
  return 'NO_GO';
}

export function validateReservedRegexPattern(_input: unknown): false {
  return false;
}
