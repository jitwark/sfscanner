export const BUDGET_KEYS_V2 = Object.freeze([
  'maxBytes',
  'maxNodes',
  'maxEdges',
  'maxConnectionDepth',
  'maxParameterDepth',
  'maxParameterLeaves',
  'workerDeadlineMs',
  'maxSyntaxNodes',
  'maxDocumentDepth',
  'maxMembersAndElements',
  'maxRawEdges',
  'maxDuplicateKeys',
  'maxDiagnostics',
  'maxStoredSourceSpans',
  'maxSourceWork',
  'maxExpressionTokens',
  'maxCodeSyntaxNodes',
  'maxGraphOperations',
  'maxTaintStates',
  'maxTraceStepsPerFinding',
  'maxFindings',
  'maxRedactionPatches',
  'maxRedactedArtifactBytes',
  'maxEvidenceBytes',
  'maxSerializedResultBytes',
  'maxRuleOperations',
] as const);

export type BudgetKeyV2 = (typeof BUDGET_KEYS_V2)[number];
export type BudgetAggregateEffectV2 = 'DEGRADED' | 'INDETERMINATE';

export type BudgetOutcomeV2 = Readonly<
  | { kind: 'ITEM_ERROR'; code: 'WORKFLOW_TOO_LARGE' | 'WORKFLOW_TOO_COMPLEX' }
  | {
      kind: 'DIAGNOSTIC';
      code: 'OPTIONAL_LIMIT_EXCEEDED' | 'REQUIRED_LIMIT_EXCEEDED' | 'GRAPH_WORK_LIMIT_EXCEEDED';
      aggregateEffect: BudgetAggregateEffectV2;
      assessmentEligible: boolean;
      reservedDiagnosticSlots?: 1;
    }
  | { kind: 'REDACTION_ERROR'; code: 'REDACTION_LIMIT_EXCEEDED' }
  | { kind: 'HOST_ERROR'; code: 'SCAN_TIMEOUT' }
>;

export type BudgetOutcomeContextV2 = Readonly<{
  budget: BudgetKeyV2;
  capabilityRequired?: boolean;
  securityRequired?: boolean;
}>;

const KNOWN_BUDGETS = new Set<string>(BUDGET_KEYS_V2);

const SHAPE_BUDGETS = new Set<BudgetKeyV2>([
  'maxSyntaxNodes', 'maxDocumentDepth', 'maxMembersAndElements', 'maxNodes',
  'maxRawEdges', 'maxEdges', 'maxConnectionDepth', 'maxParameterDepth',
  'maxParameterLeaves', 'maxDuplicateKeys', 'maxSerializedResultBytes', 'maxSourceWork',
]);

const CAPABILITY_BUDGETS = new Set<BudgetKeyV2>([
  'maxExpressionTokens', 'maxCodeSyntaxNodes', 'maxTaintStates',
  'maxTraceStepsPerFinding', 'maxFindings', 'maxEvidenceBytes', 'maxRuleOperations',
]);

export function classifyBudgetOutcome(context: BudgetOutcomeContextV2): BudgetOutcomeV2 {
  const { budget } = context;
  if (!KNOWN_BUDGETS.has(budget)) throw new TypeError('Unknown scanner budget');
  if (budget === 'maxBytes') return frozen({ kind: 'ITEM_ERROR', code: 'WORKFLOW_TOO_LARGE' });
  if (SHAPE_BUDGETS.has(budget)) return frozen({ kind: 'ITEM_ERROR', code: 'WORKFLOW_TOO_COMPLEX' });
  if (budget === 'maxDiagnostics') return frozen({
    kind: 'DIAGNOSTIC', code: 'REQUIRED_LIMIT_EXCEEDED', aggregateEffect: 'INDETERMINATE',
    assessmentEligible: false, reservedDiagnosticSlots: 1,
  });
  if (budget === 'maxStoredSourceSpans') {
    return context.securityRequired ? requiredLimit() : optionalLimit();
  }
  if (CAPABILITY_BUDGETS.has(budget)) return byCapability(context.capabilityRequired);
  if (budget === 'maxGraphOperations') {
    const required = requireCapabilityRequired(context.capabilityRequired);
    return frozen({
      kind: 'DIAGNOSTIC', code: 'GRAPH_WORK_LIMIT_EXCEEDED',
      aggregateEffect: required ? 'INDETERMINATE' : 'DEGRADED', assessmentEligible: !required,
    });
  }
  if (budget === 'maxRedactionPatches' || budget === 'maxRedactedArtifactBytes') {
    return frozen({ kind: 'REDACTION_ERROR', code: 'REDACTION_LIMIT_EXCEEDED' });
  }
  return frozen({ kind: 'HOST_ERROR', code: 'SCAN_TIMEOUT' });
}

export function diagnosticCapacity(maxDiagnostics: number): number {
  if (!Number.isSafeInteger(maxDiagnostics) || maxDiagnostics < 1) {
    throw new TypeError('maxDiagnostics must reserve at least one diagnostic slot');
  }
  return maxDiagnostics - 1;
}

function byCapability(requiredness: boolean | undefined): BudgetOutcomeV2 {
  return requireCapabilityRequired(requiredness) ? requiredLimit() : optionalLimit();
}

function requireCapabilityRequired(value: boolean | undefined): boolean {
  if (typeof value !== 'boolean') throw new TypeError('capabilityRequired must be fixed before execution');
  return value;
}

function requiredLimit(): BudgetOutcomeV2 {
  return frozen({
    kind: 'DIAGNOSTIC', code: 'REQUIRED_LIMIT_EXCEEDED',
    aggregateEffect: 'INDETERMINATE', assessmentEligible: false,
  });
}

function optionalLimit(): BudgetOutcomeV2 {
  return frozen({
    kind: 'DIAGNOSTIC', code: 'OPTIONAL_LIMIT_EXCEEDED',
    aggregateEffect: 'DEGRADED', assessmentEligible: true,
  });
}

function frozen<const T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}
