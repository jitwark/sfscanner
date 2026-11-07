import { parser } from '@lezer/python';
import type { AnalyzerContextV2, CapabilityCandidateV2, FindingCandidateV2, SafeFactV2 } from './scheduler';
import type { SourceMemberRefV2 } from '../source/source-types';
import type { AnalysisDiagnosticV2 } from '../diagnostics/registry';
import type { SecurityNodeV2 } from '../workflow-v2/security-workflow';
import { admitCandidate, createDiagnostic, makeFact } from './adapter-evidence';

type Cst = { name: string; from: number; to: number; type: { isError: boolean }; firstChild: Cst | null; nextSibling: Cst | null };
type Binding = { module: string; member?: string } | null;
type Event = { at: number; value: Binding };
type Scope = { from: number; to: number; parent?: Scope; children: Scope[]; bindings: Map<string, Event[]> };
type Source = { text: string; ref: SourceMemberRefV2 };
type Indicator = { indicator: string; member?: string; start: number; end: number };

export const MAX_PYTHON_SOURCE_BYTES = 100_000;
export const MAX_PYTHON_FINDINGS_PER_SOURCE = 10;
const CAPABILITY_ID = 'python-security';
const SUBPROCESS = new Set(['run', 'Popen', 'call', 'check_call', 'check_output']);
const OS_PROCESS = /^(?:system|popen|exec(?:l|le|lp|lpe|v|ve|vp|vpe)|spawn(?:l|le|lp|lpe|v|ve|vp|vpe)|posix_spawnp?)$/;
const NETWORK_MODULES = new Set(['requests', 'httpx', 'urllib', 'urllib.request', 'http.client', 'socket']);
const NETWORK_METHODS = new Set(['get', 'post', 'request', 'urlopen', 'create_connection', 'connect', 'connect_ex', 'sendall']);

/** Analyze one parser-admitted n8n node without importing or executing submitted code. */
export function evaluatePythonSecurity(node: SecurityNodeV2, context: AnalyzerContextV2): CapabilityCandidateV2 {
  const selection = sourcesFor(node);
  if (selection.sources.length === 0) return admitted([], [], selection.unavailable === undefined ? [] : [createDiagnostic('PYTHON_SOURCE_UNAVAILABLE', CAPABILITY_ID, false, selection.unavailable)], 1, 0, 1, selection.unavailable === undefined ? 0 : 1);
  const facts: SafeFactV2[] = [], findings: FindingCandidateV2[] = [], diagnostics: AnalysisDiagnosticV2[] = [];
  const sourceLimit = Math.min(MAX_PYTHON_FINDINGS_PER_SOURCE, context.limits.maxFindings);
  let omitted = selection.unavailable === undefined ? 0 : 1, analyzed = 0;
  if (selection.unavailable !== undefined) diagnostics.push(createDiagnostic('PYTHON_SOURCE_UNAVAILABLE', CAPABILITY_ID, false, selection.unavailable));
  for (const source of selection.sources) {
    analyzed += 1;
    if (new TextEncoder().encode(source.text).length > MAX_PYTHON_SOURCE_BYTES) { diagnostics.push(limit(source.ref)); omitted += 1; continue; }
    const scan = scanSource(source.text, context.limits.maxCodeSyntaxNodes, context.limits.maxExpressionTokens);
    let limited = scan.nodeLimited || scan.tokenLimited, produced = 0;
    if (scan.recovered) diagnostics.push(createDiagnostic('PYTHON_PARSE_FAILED', CAPABILITY_ID, false, source.ref));
    for (const item of scan.indicators) {
      if (produced >= sourceLimit || facts.length >= context.limits.maxFindings) { omitted += 1; limited = true; continue; }
      produced += 1;
      const properties = { language: 'PYTHON', indicator: item.indicator, ...(item.member === undefined ? {} : { member: item.member }), start: item.start, end: item.end, parseState: scan.recovered ? 'RECOVERED' : 'VERIFIED' } as Record<string, string | number>;
      const fact = makeFact('code.indicator.v2', { kind: 'SOURCE', source: source.ref }, properties); facts.push(fact);
      findings.push({ ruleId: 'PYTHON_DYNAMIC_EXECUTION', evidenceClass: 'SUSPICIOUS_SYNTAX', conclusion: scan.recovered ? 'POTENTIAL' : 'OBSERVED', applicability: 'APPLICABLE', subject: { kind: 'NODE', node: node.ref }, factRefs: [fact.factId], traceRefs: [], remediationId: 'r' });
    }
    if (limited) diagnostics.push(limit(source.ref));
  }
  return admitted(findings, facts, diagnostics, 1, analyzed, 0, omitted);
}
export const analyzePythonSecurity = evaluatePythonSecurity;

function admitted(findings: FindingCandidateV2[], facts: SafeFactV2[], diagnostics: AnalysisDiagnosticV2[], seen: number, analyzed: number, skipped: number, omitted: number): CapabilityCandidateV2 { return admitCandidate({ findings, diagnostics, facts, traces: [], seen, analyzed, skipped, omitted }); }
function limit(ref: SourceMemberRefV2): AnalysisDiagnosticV2 { return createDiagnostic('OPTIONAL_LIMIT_EXCEEDED', CAPABILITY_ID, false, ref, { observed: 1, maximum: 0, omitted: 1 }); }
function sourcesFor(node: SecurityNodeV2): { sources: Source[]; unavailable?: SourceMemberRefV2 } {
  if (node.type !== 'n8n-nodes-base.code' || node.typeVersion !== '2.0.0' || fieldValue(node, 'language') !== 'python' && fieldValue(node, 'language') !== 'pythonNative') return { sources: [] };
  const fields = node.parameters.filter((field) => last(field.pointer) === 'pythonCode');
  const sources = fields.filter((field) => typeof field.value === 'string').map((field) => ({ text: field.value as string, ref: field.occurrences[0] ?? node.ref.source }));
  const missing = fields.find((field) => typeof field.value !== 'string');
  if (fields.length === 0) return { sources, unavailable: node.ref.source };
  return { sources, ...(missing === undefined ? {} : { unavailable: missing.occurrences[0] ?? node.ref.source }) };
}
function fieldValue(node: SecurityNodeV2, name: string): string | undefined { const field = node.parameters.find((item) => last(item.pointer) === name); return typeof field?.value === 'string' ? field.value : undefined; }
function last(pointer: string): string { return pointer.slice(pointer.lastIndexOf('/') + 1).replaceAll('~1', '/').replaceAll('~0', '~'); }

function scanSource(source: string, maxNodes: number, maxTokens: number): { indicators: Indicator[]; recovered: boolean; nodeLimited: boolean; tokenLimited: boolean } {
  let root: Cst;
  try { root = parser.parse(source).cursor().node as unknown as Cst; } catch { return { indicators: [], recovered: true, nodeLimited: false, tokenLimited: false }; }
  const collected = collectBindings(root, source, maxNodes), scope = collected.scope, stack: Array<{ node: Cst; scope: Scope }> = [{ node: root, scope }], indicators: Indicator[] = [];
  let visited = 0, leaves = 0, recovered = false, nodeLimited = collected.limited;
  while (stack.length) { const entry = stack.pop()!; const current = entry.node; if (++visited > maxNodes) { nodeLimited = true; break; } if (current.type.isError) recovered = true; if (!current.firstChild) leaves += 1; const active = scopeAt(scope, current.from); if (current.name === 'CallExpression') { const item = indicatorForCall(current, source, active); if (item) indicators.push(item); } else if (current.name === 'MemberExpression') { const item = indicatorForMember(current, source, active); if (item) indicators.push(item); } stack.push(...directChildren(current).reverse().map((child) => ({ node: child, scope: active }))); }
  const tokenLimited = leaves > maxTokens;
  return { indicators: tokenLimited ? [] : indicators.sort((a, b) => a.start - b.start || a.end - b.end), recovered, nodeLimited, tokenLimited };
}
function indicatorForMember(memberNode: Cst, source: string, scope: Scope): Indicator | undefined {
  const [module, , property] = directChildren(memberNode); if (!module || !property || module.name !== 'VariableName') return undefined;
  const moduleName = source.slice(module.from, module.to), member = source.slice(property.from, property.to), binding = bindingAt(scope, moduleName, module.from);
  const resolved = binding === null ? undefined : binding?.module ?? moduleName;
  return resolved === 'os' && (member === 'environ' || member === 'getenv') ? item('ENVIRONMENT_ACCESS', memberNode, member) : undefined;
}
function indicatorForCall(call: Cst, source: string, scope: Scope): Indicator | undefined {
  const [callee] = directChildren(call); if (!callee) return undefined;
  if (callee.name === 'VariableName') {
    const name = source.slice(callee.from, callee.to), binding = bindingAt(scope, name, callee.from);
    if (binding === undefined) { if (name === 'eval' || name === 'exec') return item(name === 'exec' ? 'EXEC' : 'EVAL', call); if (name === '__import__' || name === 'import_module') return item('DYNAMIC_IMPORT', call); if (name === 'open') return item('FILESYSTEM_ACCESS', call, 'open'); }
    if (binding?.module === 'subprocess' && binding.member && SUBPROCESS.has(binding.member)) return item('SHELL_SUBPROCESS', call, binding.member);
    if (binding?.module === 'os' && binding.member && OS_PROCESS.test(binding.member)) return item('SHELL_SUBPROCESS', call, binding.member);
    if (binding?.module === 'importlib' && binding.member === 'import_module') return item('DYNAMIC_IMPORT', call, binding.member);
    if (binding?.module === 'requests' || binding?.module === 'httpx') return item('NETWORK_ACCESS', call, name);
    return undefined;
  }
  const [module, , property] = directChildren(callee); if (!module || !property) return undefined;
  const moduleName = source.slice(module.from, module.to), member = source.slice(property.from, property.to), binding = bindingAt(scope, moduleName, module.from);
  const resolved = binding === null ? undefined : binding?.module ?? moduleName;
  if (resolved === 'os' && (member === 'environ' || member === 'getenv')) return item('ENVIRONMENT_ACCESS', call, member);
  if (resolved === 'subprocess' && SUBPROCESS.has(member) || resolved === 'os' && OS_PROCESS.test(member)) return item('SHELL_SUBPROCESS', call, member);
  if (resolved === 'importlib' && member === 'import_module') return item('DYNAMIC_IMPORT', call, member);
  if (resolved === 'pathlib' && ['read_text', 'write_text', 'open'].includes(member)) return item('FILESYSTEM_ACCESS', call, member);
  if (resolved !== undefined && NETWORK_MODULES.has(resolved) && NETWORK_METHODS.has(member)) return item('NETWORK_ACCESS', call, member);
  return undefined;
}
function item(indicator: string, node: Cst, member?: string): Indicator { return { indicator, ...(member === undefined ? {} : { member }), start: node.from, end: Math.max(node.from + 1, node.to) }; }
function collectBindings(root: Cst, source: string, maxNodes: number): { scope: Scope; limited: boolean } {
  const base: Scope = { from: root.from, to: root.to, children: [], bindings: new Map() }; let visited = 0, limited = false;
  const walk = (node: Cst, parent: Scope): void => { if (++visited > maxNodes) { limited = true; return; } let scope = parent; if (node.name === 'FunctionDefinition' || node.name === 'ClassDefinition') { const name = directChildren(node).find((child) => child.name === 'VariableName'); if (name) addBinding(parent, source.slice(name.from, name.to), node.from, null); } if (node !== root && (node.name === 'FunctionDefinition' || node.name === 'ClassDefinition' || node.name === 'LambdaExpression')) { scope = { from: node.from, to: node.to, parent, children: [], bindings: new Map() }; parent.children.push(scope); } if (node.name === 'ImportStatement') registerImport(node, source, scope); if (node.name === 'AssignStatement') { const target = directChildren(node)[0]; if (target?.name === 'VariableName') addBinding(scope, source.slice(target.from, target.to), node.from, null); } if (node.name === 'ParamList') for (const child of directChildren(node)) if (child.name === 'VariableName') addBinding(scope, source.slice(child.from, child.to), node.from, null); for (const child of directChildren(node)) walk(child, scope); };
  walk(root, base); return { scope: base, limited };
}
function registerImport(node: Cst, source: string, scope: Scope): void {
  const values = directChildren(node), from = values.findIndex((child) => child.name === 'from');
  if (from >= 0 && values[from + 1]) { const moduleName = source.slice(values[from + 1]!.from, values[from + 1]!.to); let imported: string | undefined; for (let index = from + 2; index < values.length; index += 1) { const child = values[index]!; if (child.name !== 'VariableName') continue; const name = source.slice(child.from, child.to); if (values[index - 1]?.name === 'as' && imported !== undefined) { addBinding(scope, name, node.from, { module: moduleName, member: imported }); imported = undefined; } else if (imported === undefined) imported = name; else { addBinding(scope, imported, node.from, { module: moduleName, member: imported }); imported = name; } } if (imported !== undefined) addBinding(scope, imported, node.from, { module: moduleName, member: imported }); return; }
  for (let index = 1; index < values.length;) {
    if (values[index]?.name !== 'VariableName') { index += 1; continue; }
    const parts = [source.slice(values[index]!.from, values[index]!.to)];
    index += 1;
    while (values[index]?.name === '.' && values[index + 1]?.name === 'VariableName') {
      parts.push(source.slice(values[index + 1]!.from, values[index + 1]!.to));
      index += 2;
    }
    let local = parts[0]!;
    let moduleName = parts[0]!;
    if (values[index]?.name === 'as' && values[index + 1]?.name === 'VariableName') {
      local = source.slice(values[index + 1]!.from, values[index + 1]!.to);
      moduleName = parts.join('.');
      index += 2;
    }
    addBinding(scope, local, node.from, { module: moduleName });
  }
}
function addBinding(scope: Scope, name: string, at: number, value: Binding): void { const events = scope.bindings.get(name) ?? []; events.push({ at, value }); scope.bindings.set(name, events); }
function bindingAt(root: Scope, name: string, at: number): Binding | undefined { let scope: Scope | undefined = scopeAt(root, at); while (scope) { const events = scope.bindings.get(name); if (events) { let value: Binding | undefined; for (const event of events) if (event.at <= at) value = event.value; if (value !== undefined) return value; } scope = scope.parent; } return undefined; }
function scopeAt(scope: Scope, at: number): Scope { for (const child of scope.children) if (at >= child.from && at < child.to) return scopeAt(child, at); return scope; }
function directChildren(node: Cst): Cst[] { const children: Cst[] = []; for (let child = node.firstChild; child; child = child.nextSibling) children.push(child); return children; }
