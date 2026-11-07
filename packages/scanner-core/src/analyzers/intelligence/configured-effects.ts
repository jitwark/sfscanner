import type { ResolvedNodeSemanticsV2, SemanticEffectV2 } from '../../semantics/catalogue-schema';
import type { SecurityWorkflowV2 } from '../../workflow-v2/security-workflow';

export const EIGHT_EFFECT_ORDER = Object.freeze([
  'READ_EXTERNAL', 'WRITE_EXTERNAL', 'EXECUTE_CODE', 'EXECUTE_COMMAND', 'READ_FILE',
  'WRITE_FILE', 'DATABASE_READ', 'DATABASE_WRITE', 'SEND_MESSAGE', 'CALL_TOOL', 'START_SUBWORKFLOW',
] as const satisfies readonly SemanticEffectV2[]);

export type ConfiguredEffectSummaryV1 = Readonly<{
  totalNodes: number;
  reviewedNodes: number;
  assumedNodes: number;
  unknownNodes: number;
  effectCounts: readonly number[];
  disabledEffectNodes: number;
}>;
export type ConfiguredEffectInputV1 = Readonly<{
  workflow: SecurityWorkflowV2;
  semantics: ReadonlyMap<string, ResolvedNodeSemanticsV2>;
}>;

/** Potential configured capabilities only; never proof of execution, installation, or permission. */
export function summarizeConfiguredEffects(input: ConfiguredEffectInputV1): ConfiguredEffectSummaryV1 {
  const counts = EIGHT_EFFECT_ORDER.map(() => 0);
  let reviewedNodes = 0;
  let assumedNodes = 0;
  let unknownNodes = 0;
  let disabledEffectNodes = 0;
  for (let index = 0; index < input.workflow.nodes.length; index += 1) {
    const node = input.workflow.nodes[index]!;
    const semantics = input.semantics.get(node.ref.identityDigest);
    if (semantics === undefined || semantics.nodeType !== node.type) { unknownNodes += 1; continue; }
    if (semantics.semanticId === 'generic.fallback') assumedNodes += 1;
    else reviewedNodes += 1;
    let hasEffect = false;
    for (let effectIndex = 0; effectIndex < EIGHT_EFFECT_ORDER.length; effectIndex += 1) {
      let present = false;
      for (let sourceIndex = 0; sourceIndex < semantics.effects.length; sourceIndex += 1) if (semantics.effects[sourceIndex] === EIGHT_EFFECT_ORDER[effectIndex]) { present = true; break; }
      if (present) {
        counts[effectIndex] += 1;
        hasEffect = true;
      }
    }
    if (hasEffect && node.disabled) disabledEffectNodes += 1;
  }
  return Object.freeze({
    totalNodes: input.workflow.nodes.length, reviewedNodes, assumedNodes, unknownNodes,
    effectCounts: Object.freeze(counts), disabledEffectNodes,
  });
}
