import type { NormalizedWorkflowNode } from '../../workflow';

export type EmbeddedCodeLanguage = 'javascript' | 'python';

export type EmbeddedCodeSelection =
  | { kind: 'SOURCE'; language: EmbeddedCodeLanguage; field: string; source: string }
  | { kind: 'SOURCE_UNAVAILABLE'; language: EmbeddedCodeLanguage; field: string }
  | { kind: 'UNSUPPORTED_VARIANT' }
  | { kind: 'NOT_A_CODE_NODE' };

const CODE_NODE_TYPE = 'n8n-nodes-base.code';
const LANGCHAIN_TOOL_CODE_TYPE = '@n8n/n8n-nodes-langchain.toolCode';
const LANGCHAIN_CODE_TYPE = '@n8n/n8n-nodes-langchain.code';
const LEGACY_FUNCTION_TYPES = new Set(['n8n-nodes-base.function', 'n8n-nodes-base.functionItem']);
const PYTHON_LANGUAGES = new Set(['python', 'pythonNative']);
/**
 * LangChain Code keeps one code body per execution path: `code.execute.code` runs
 * for a main input/output, `code.supplyData.code` when the node supplies a component.
 */
const LANGCHAIN_CODE_ISLANDS = [
  { option: 'execute', field: '/code/execute/code' },
  { option: 'supplyData', field: '/code/supplyData/code' },
] as const;

/** Mirrors n8n's executable-field selection without executing workflow code. */
export function selectExecutableCode(node: NormalizedWorkflowNode): EmbeddedCodeSelection {
  if (LEGACY_FUNCTION_TYPES.has(node.type)) {
    if (node.typeVersion !== undefined && node.typeVersion !== 1) return { kind: 'UNSUPPORTED_VARIANT' };
    return sourceFor(node, 'javascript', 'functionCode');
  }

  if (node.type === LANGCHAIN_TOOL_CODE_TYPE) {
    const language = node.parameters.language ?? 'javaScript';
    if (language === 'javaScript') return sourceFor(node, 'javascript', 'jsCode');
    if (typeof language === 'string' && PYTHON_LANGUAGES.has(language)) return sourceFor(node, 'python', 'pythonCode');
    return { kind: 'UNSUPPORTED_VARIANT' };
  }

  if (node.type === LANGCHAIN_CODE_TYPE) return selectLangChainCode(node);

  if (node.type !== CODE_NODE_TYPE) return { kind: 'NOT_A_CODE_NODE' };

  const language = node.typeVersion === 2 ? node.parameters.language ?? 'javaScript' : 'javaScript';
  if (language === 'javaScript') return sourceFor(node, 'javascript', 'jsCode');
  if (typeof language === 'string' && PYTHON_LANGUAGES.has(language)) {
    return sourceFor(node, 'python', 'pythonCode');
  }

  return { kind: 'UNSUPPORTED_VARIANT' };
}

function sourceFor(
  node: NormalizedWorkflowNode,
  language: EmbeddedCodeLanguage,
  field: string,
): EmbeddedCodeSelection {
  const source = node.parameters[field];
  return typeof source === 'string'
    ? { kind: 'SOURCE', language, field, source }
    : { kind: 'SOURCE_UNAVAILABLE', language, field };
}

function selectLangChainCode(node: NormalizedWorkflowNode): EmbeddedCodeSelection {
  const code = node.parameters.code;
  if (code === undefined) return { kind: 'SOURCE_UNAVAILABLE', language: 'javascript', field: '/code' };
  if (typeof code !== 'object' || code === null || Array.isArray(code)) return { kind: 'UNSUPPORTED_VARIANT' };

  let selected: { field: string; source: string } | undefined;
  for (const { option, field } of LANGCHAIN_CODE_ISLANDS) {
    const path = (code as Record<string, unknown>)[option];
    if (path === undefined) continue;
    if (typeof path !== 'object' || path === null || Array.isArray(path)) return { kind: 'UNSUPPORTED_VARIANT' };
    const source = (path as Record<string, unknown>).code;
    if (source === undefined || source === '') continue;
    if (typeof source !== 'string') return { kind: 'UNSUPPORTED_VARIANT' };
    // Both execution paths run their own code body; selecting one would drop the other silently.
    if (selected) return { kind: 'UNSUPPORTED_VARIANT' };
    selected = { field, source };
  }

  return selected
    ? { kind: 'SOURCE', language: 'javascript', field: selected.field, source: selected.source }
    : { kind: 'SOURCE_UNAVAILABLE', language: 'javascript', field: '/code' };
}
