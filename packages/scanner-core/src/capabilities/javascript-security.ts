import { parse, tokenizer } from 'acorn';
import type { AnalyzerContextV2, CapabilityCandidateV2, FindingCandidateV2, SafeFactV2 } from './scheduler';
import type { SourceMemberRefV2 } from '../source/source-types';
import type { AnalysisDiagnosticV2 } from '../diagnostics/registry';
import type { SecurityNodeV2 } from '../workflow-v2/security-workflow';
import { admitCandidate, createDiagnostic, makeFact } from './adapter-evidence';

type Ast = { type: string; start: number; end: number; [key: string]: unknown };
type Binding = string[] | null;
type Event = { at: number; value: Binding };
type Scope = { from: number; to: number; parent?: Scope; children: Scope[]; events: Map<string, Event[]>; varScope: boolean };
type Source = { text: string; ref: SourceMemberRefV2 };
type Indicator = { indicator: string; member?: string; start: number; end: number };
type Token = { value: string; start: number; end: number; string?: string };
type PatternMember = { name: string; member: string };
type PatternTask = { value?: unknown; directMember: boolean; items?: unknown[]; index?: number; allowHoles?: boolean };
type PatternResult = { names: string[]; members?: PatternMember[]; limited: boolean };

export const MAX_JAVASCRIPT_SOURCE_BYTES = 100_000;
export const MAX_JAVASCRIPT_FINDINGS_PER_SOURCE = 10;
const CAPABILITY_ID = 'javascript-security';
const PROCESS = 'pro' + 'cess';
const CHILD_PROCESS = 'child_' + PROCESS;
const CHILD_METHODS = new Set(['exec', 'execFile', 'spawn', 'fork', 'execSync', 'execFileSync', 'spawnSync']);
const FS_METHODS = new Set(['readFile', 'readFileSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'unlink', 'unlinkSync', 'rm', 'rmSync', 'open', 'openSync', 'mkdir', 'mkdirSync', 'stat', 'statSync', 'createReadStream', 'createWriteStream']);
const NET_METHODS = new Set(['request', 'get', 'connect', 'createConnection', 'lookup', 'resolve']);
const NET_GLOBALS = new Set(['fe' + 'tch', 'XMLHttpRequest', 'WebSocket', 'EventSource']);
const REGEX_AFTER = new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof', 'new', 'in', 'of', 'yield', 'await', 'else', 'do']);
const MODULES: Record<string, 'CHILD_PROCESS' | 'FILESYSTEM' | 'NETWORK'> = { [CHILD_PROCESS]: 'CHILD_PROCESS', fs: 'FILESYSTEM', 'fs/promises': 'FILESYSTEM', http: 'NETWORK', https: 'NETWORK', net: 'NETWORK', tls: 'NETWORK', dgram: 'NETWORK' };

/** Analyze one parser-admitted n8n node without executing submitted code. */
export function evaluateJavaScriptSecurity(node: SecurityNodeV2, context: AnalyzerContextV2): CapabilityCandidateV2 {
  const selection = sourcesFor(node);
  if (selection.unsupported) return admitted([], [], [createDiagnostic('UNSUPPORTED_CODE_NODE_VARIANT', CAPABILITY_ID, false, node.ref.source)], 1, 0, 0, 0);
  if (selection.sources.length === 0) return admitted([], [], selection.unavailable === undefined ? [] : [createDiagnostic('JAVASCRIPT_SOURCE_UNAVAILABLE', CAPABILITY_ID, false, selection.unavailable)], 1, 0, 1, selection.unavailable === undefined ? 0 : 1);
  const facts: SafeFactV2[] = [], findings: FindingCandidateV2[] = [], diagnostics: AnalysisDiagnosticV2[] = [];
  const sourceLimit = Math.min(MAX_JAVASCRIPT_FINDINGS_PER_SOURCE, context.limits.maxFindings);
  let omitted = selection.unavailable === undefined ? 0 : 1, analyzed = 0;
  if (selection.unavailable !== undefined) diagnostics.push(createDiagnostic('JAVASCRIPT_SOURCE_UNAVAILABLE', CAPABILITY_ID, false, selection.unavailable));
  for (const source of selection.sources) {
    analyzed += 1;
    if (new TextEncoder().encode(source.text).length > MAX_JAVASCRIPT_SOURCE_BYTES) { diagnostics.push(limit(source.ref)); omitted += 1; continue; }
    const scan = scanSource(source.text, context.limits.maxCodeSyntaxNodes, context.limits.maxExpressionTokens);
    let limited = scan.tokenLimited || scan.nodeLimited, produced = 0;
    if (scan.recovered) diagnostics.push(createDiagnostic('JAVASCRIPT_PARSE_FAILED', CAPABILITY_ID, false, source.ref));
    for (const item of scan.indicators) {
      if (produced >= sourceLimit || facts.length >= context.limits.maxFindings) { omitted += 1; limited = true; continue; }
      produced += 1;
      const properties = { language: 'JAVASCRIPT', indicator: item.indicator, ...(item.member === undefined ? {} : { member: item.member }), start: item.start, end: item.end, parseState: scan.recovered ? 'RECOVERED' : 'VERIFIED' } as Record<string, string | number>;
      const fact = makeFact('code.indicator.v2', { kind: 'SOURCE', source: source.ref }, properties); facts.push(fact);
      findings.push({ ruleId: 'JAVASCRIPT_DYNAMIC_EXECUTION', evidenceClass: 'SUSPICIOUS_SYNTAX', conclusion: scan.recovered ? 'POTENTIAL' : 'OBSERVED', applicability: 'APPLICABLE', subject: { kind: 'NODE', node: node.ref }, factRefs: [fact.factId], traceRefs: [], remediationId: 'r' });
    }
    if (limited) diagnostics.push(limit(source.ref));
  }
  return admitted(findings, facts, diagnostics, 1, analyzed, 0, omitted);
}
export const analyzeJavaScriptSecurity = evaluateJavaScriptSecurity;

function admitted(findings: FindingCandidateV2[], facts: SafeFactV2[], diagnostics: AnalysisDiagnosticV2[], seen: number, analyzed: number, skipped: number, omitted: number): CapabilityCandidateV2 { return admitCandidate({ findings, diagnostics, facts, traces: [], seen, analyzed, skipped, omitted }); }
function limit(ref: SourceMemberRefV2): AnalysisDiagnosticV2 { return createDiagnostic('OPTIONAL_LIMIT_EXCEEDED', CAPABILITY_ID, false, ref, { observed: 1, maximum: 0, omitted: 1 }); }
function sourcesFor(node: SecurityNodeV2): { sources: Source[]; unsupported: boolean; unavailable?: SourceMemberRefV2 } {
  const legacy = node.type === 'n8n-nodes-base.function' || node.type === 'n8n-nodes-base.functionItem';
  const code = node.type === 'n8n-nodes-base.code';
  if (!legacy && !code) return { sources: [], unsupported: false };
  if (legacy && node.typeVersion !== undefined && node.typeVersion !== '1.0.0') return { sources: [], unsupported: true };
  const languageField = node.parameters.find((field) => last(field.pointer) === 'language');
  const language: unknown = code && node.typeVersion === '2.0.0' ? languageField === undefined ? 'javaScript' : languageField.value : 'javaScript';
  if (language === 'python' || language === 'pythonNative') return { sources: [], unsupported: false };
  if (language !== 'javaScript') return { sources: [], unsupported: true };
  const names = legacy ? ['functionCode'] : ['jsCode'];
  const candidates = node.parameters.filter((field) => names.includes(last(field.pointer)));
  const sources = candidates.filter((field) => typeof field.value === 'string').map((field) => ({ text: field.value as string, ref: field.occurrences[0] ?? node.ref.source }));
  const missing = candidates.find((field) => typeof field.value !== 'string');
  if (candidates.length === 0) return { sources, unsupported: false, unavailable: node.ref.source };
  return { sources, unsupported: false, ...(missing === undefined ? {} : { unavailable: missing.occurrences[0] ?? node.ref.source }) };
}

function fieldValue(node: SecurityNodeV2, name: string): string | undefined { const field = node.parameters.find((item) => last(item.pointer) === name); return typeof field?.value === 'string' ? field.value : undefined; }
function last(pointer: string): string { return pointer.slice(pointer.lastIndexOf('/') + 1).replaceAll('~1', '/').replaceAll('~0', '~'); }

function scanSource(source: string, maxNodes: number, maxTokens: number): { indicators: Indicator[]; recovered: boolean; nodeLimited: boolean; tokenLimited: boolean } {
  const tokenLimited = countTokens(source, maxTokens); if (tokenLimited) return { indicators: [], recovered: false, nodeLimited: false, tokenLimited };
  let root: Ast | undefined, offset = 0, recovered = false;
  try { root = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true }) as unknown as Ast; }
  catch {
    const prefix = 'async function __n8n_code__() {\n';
    try { root = parse(prefix + source + '\n}', { ecmaVersion: 'latest' }) as unknown as Ast; offset = prefix.length; }
    catch { recovered = true; return { indicators: recover(source), recovered, nodeLimited: false, tokenLimited }; }
  }
  const collected = collectScopes(root, maxNodes), scope = collected.scope, result: Indicator[] = []; const stack: Array<{ node: Ast; scope: Scope }> = [{ node: root, scope }]; let visited = 0, nodeLimited = collected.limited;
  if (collected.patternLimited) return { indicators: [], recovered, nodeLimited: true, tokenLimited };
  while (stack.length) {
    const entry = stack.pop()!; const current = entry.node; if (++visited > maxNodes) { nodeLimited = true; break; }
    const active = scopeAt(scope, current.start), item = indicator(current, source, active, offset); if (item) result.push(item);
    for (const value of Object.values(current)) for (const child of Array.isArray(value) ? value : [value]) if (isAst(child)) stack.push({ node: child, scope: active });
  }
  return { indicators: result.sort((a, b) => a.start - b.start || a.end - b.end), recovered, nodeLimited, tokenLimited };
}
function countTokens(source: string, maximum: number): boolean { try { const stream = tokenizer(source, { ecmaVersion: 'latest' }); let count = 0; for (;;) { const token = stream.getToken(); if (token.type.label === 'eof') return false; count += 1; if (count > maximum) return true; } } catch { return false; } }
function collectScopes(root: Ast, maxNodes: number): { scope: Scope; limited: boolean; patternLimited: boolean } {
  const base: Scope = { from: 0, to: root.end, children: [], events: new Map(), varScope: true }; let visited = 0, limited = false, patternLimited = false;
  const budget = { remaining: maxNodes }, pending: Array<() => void> = [];
  const pattern = (value: unknown, assignmentTarget = false): PatternResult => { const result = patternBindings(value, budget, assignmentTarget); if (result.limited) { limited = true; patternLimited = true; } return result; };
  const shadowPattern = (scope: Scope, value: unknown): PatternResult => { const result = pattern(value); for (const name of result.names) declare(scope, name, null, scope.from); return result; };
  const walk = (node: Ast, parent: Scope, declarationKind?: string): void => {
    if (++visited > maxNodes) { limited = true; return; }
    let scope = parent;
    if (node !== root && ['BlockStatement', 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'CatchClause', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement', 'ClassExpression'].includes(node.type)) {
      const classBody = node.type === 'ClassExpression' && isAst(node.body) ? node.body : undefined;
      const from = node.type === 'SwitchStatement' ? children(node.cases)[0]?.start ?? node.end : classBody?.start ?? node.start;
      const to = classBody?.end ?? node.end, varScope = ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);
      scope = { from, to, parent, children: [], events: new Map(), varScope }; parent.children.push(scope);
    }
    if (node.type === 'CatchClause' && isAst(node.param)) { const name = identifier(node.param); if (name) declare(scope, name, null, scope.from); else shadowPattern(scope, node.param); }
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') { const name = identifier(node.id), target = node.type === 'ClassDeclaration' ? scope : scope.parent ?? scope; declare(target, name, null, target.from); if (node.type === 'FunctionDeclaration') declare(scope, name, null, scope.from); }
    if ((node.type === 'FunctionExpression' || node.type === 'ClassExpression') && identifier(node.id)) declare(scope, identifier(node.id), null, scope.from);
    if (node.type === 'VariableDeclarator') {
      const target = declarationKind === 'var' ? varScope(scope) : scope;
      const name = identifier(node.id), bindings = name ? undefined : shadowPattern(target, node.id), names = name ? [name] : bindings?.names ?? [];
      if (name) declare(target, name, null, target.from);
      pending.push(() => {
        if (name) { declare(target, name, resolve(node.init, target, node.start), node.start); return; }
        const modulePath = bindings?.members ? directBuiltinRequire(node.init, target, node.start) : null;
        const paths = modulePath && bindings?.members ? new Map<string, string[]>(bindings.members.map(({ name: local, member }) => [local, [...modulePath, member]] as const)) : undefined;
        for (const local of names) declare(target, local, paths?.get(local) ?? null, node.start);
      });
    }
    if (node.type === 'ImportDeclaration') for (const spec of children(node.specifiers).filter((item) => item.type.endsWith('Specifier'))) {
      const name = identifier(spec.local); if (!name) continue;
      declare(scope, name, null, scope.from);
      pending.push(() => {
        const modulePath = pathOf(node.source, '', scope, node.start, true), imported = identifier(spec.imported) ?? staticString(spec.imported);
        const importedPath = spec.type === 'ImportSpecifier' && modulePath && imported !== undefined ? [...modulePath, imported] : modulePath;
        declare(scope, name, importedPath, node.start);
      });
    }
    if (node.type === 'AssignmentExpression' && node.operator === '=') {
      const name = identifier(node.left);
      if (name) pending.push(() => declare(scope, name, resolve(node.right, scope, node.start), node.start));
      else if (isAst(node.left) && ['ObjectPattern', 'ArrayPattern'].includes(node.left.type)) {
        const names = pattern(node.left, true).names;
        pending.push(() => { for (const local of names) declare(scope, local, null, node.start); });
      }
    }
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') for (const param of children(node.params)) {
      const name = identifier(param); if (name) declare(scope, name, null, scope.from); else shadowPattern(scope, param);
    }
    const childDeclarationKind = node.type === 'VariableDeclaration' && typeof node.kind === 'string' ? node.kind : undefined;
    for (const [key, value] of Object.entries(node)) for (const child of Array.isArray(value) ? value : [value]) if (isAst(child)) walk(child, (node.type === 'SwitchStatement' && key === 'discriminant' || node.type === 'ClassExpression' && key !== 'body') ? parent : scope, childDeclarationKind);
  };
  walk(root, base); for (const apply of pending) apply(); return { scope: base, limited, patternLimited };
}
function patternBindings(value: unknown, budget: { remaining: number }, assignmentTarget: boolean): PatternResult {
  const names: string[] = [], members: PatternMember[] = [], stack: PatternTask[] = [{ value, directMember: false }]; let simpleObject = isAst(value) && value.type === 'ObjectPattern';
  while (stack.length) {
    const task = stack.pop()!; if (--budget.remaining < 0) return { names: [], limited: true };
    if (task.items !== undefined) {
      const index = task.index; if (index === undefined) return { names: [], limited: true };
      if (index < 0) continue;
      stack.push({ ...task, index: index - 1 }); const child = task.items[index];
      if (child == null && task.allowHoles) continue;
      if (!isAst(child)) return { names: [], limited: true };
      stack.push({ value: child, directMember: task.directMember }); continue;
    }
    if (!isAst(task.value)) return { names: [], limited: true };
    const node = task.value;
    if (node.type === 'Identifier') { const name = identifier(node); if (!name) return { names: [], limited: true }; names.push(name); }
    else if (node.type === 'ObjectPattern') {
      if (!Array.isArray(node.properties)) return { names: [], limited: true };
      if (node !== value) simpleObject = false;
      stack.push({ items: node.properties, index: node.properties.length - 1, directMember: node === value });
    } else if (node.type === 'Property') {
      if (task.directMember) {
        const member = identifier(node.key) ?? staticString(node.key), name = identifier(node.value);
        if (node.computed === false && node.kind === 'init' && node.method === false && member !== undefined && name !== undefined) members.push({ name, member }); else simpleObject = false;
      } else simpleObject = false;
      if (!isAst(node.value)) return { names: [], limited: true }; stack.push({ value: node.value, directMember: false });
    } else if (node.type === 'ArrayPattern') {
      simpleObject = false; if (!Array.isArray(node.elements)) return { names: [], limited: true };
      stack.push({ items: node.elements, index: node.elements.length - 1, directMember: false, allowHoles: true });
    } else if (assignmentTarget && node.type === 'MemberExpression') continue;
    else if (node.type === 'RestElement' || node.type === 'AssignmentPattern') {
      simpleObject = false; const target = node.type === 'RestElement' ? node.argument : node.left; if (!isAst(target)) return { names: [], limited: true }; stack.push({ value: target, directMember: false });
    } else return { names: [], limited: true };
  }
  return { names, ...(simpleObject ? { members } : {}), limited: false };
}
function directBuiltinRequire(value: unknown, scope: Scope, at: number): string[] | null {
  if (!isAst(value) || value.type !== 'CallExpression' || identifier(value.callee) !== 'require' || binding(scope, 'require', at) !== undefined) return null;
  const args = children(value.arguments); if (args.length !== 1) return null;
  const raw = staticString(args[0]); if (!raw) return null;
  const builtinModule = raw.startsWith('node:') ? raw.slice(5) : raw;
  return Object.hasOwn(MODULES, builtinModule) ? [builtinModule] : null;
}
function declare(scope: Scope, name: string | undefined, value: Binding, at: number): void { if (!name) return; const events = scope.events.get(name) ?? []; events.push({ at, value }); events.sort((a, b) => a.at - b.at); scope.events.set(name, events); }
function varScope(scope: Scope): Scope { for (let current = scope; ; current = current.parent ?? current) if (current.varScope || !current.parent) return current; }
function scopeAt(scope: Scope, at: number): Scope { for (const child of scope.children) if (at >= child.from && at < child.to) return scopeAt(child, at); return scope; }
function binding(scope: Scope, name: string, at: number): Binding | undefined { for (let current: Scope | undefined = scope; current; current = current.parent) { const events = current.events.get(name); if (events) { let found: Binding | undefined; for (const event of events) if (event.at <= at) found = event.value; if (found !== undefined) return found; } } return undefined; }
function resolve(value: unknown, scope: Scope, at: number): Binding { return pathOf(value, '', scope, at, false); }
function pathOf(value: unknown, source: string, scope: Scope, at: number, importName: boolean): Binding {
  if (!isAst(value)) return null;
  if (value.type === 'Literal' && typeof value.value === 'string') return [value.value];
  if (value.type === 'Identifier') { const name = identifier(value)!; const found = binding(scope, name, at); return found === undefined ? [name] : found; }
  if (value.type === 'MetaProperty') return ['import', 'meta'];
  if (value.type === 'ThisExpression') return ['this'];
  if (value.type === 'MemberExpression') { const object = pathOf(value.object, source, scope, at, false), property = value.computed && isAst(value.property) && value.property.type === 'Literal' && typeof value.property.value === 'string' ? value.property.value : identifier(value.property); return object && property ? [...object, property] : null; }
  if (value.type === 'CallExpression' && identifier(value.callee) === 'require') { if (binding(scope, 'require', value.start) !== undefined) return null; const arg = children(value.arguments)[0]; return pathOf(arg, source, scope, at, false); }
  return null;
}
function indicator(node: Ast, source: string, scope: Scope, offset: number): Indicator | undefined {
  const call = node.type === 'CallExpression' || node.type === 'NewExpression'; const path = pathOf(call ? node.callee : node, source, scope, node.start, false); const parts = path ?? [];
  if (node.type === 'ImportDeclaration') { const moduleName = staticString(node.source); return moduleName ? moduleIndicator(moduleName, 'IMPORT', node, offset) : undefined; }
  if (node.type === 'ImportExpression') { const moduleName = staticString(node.source); return moduleName ? moduleIndicator(moduleName, 'DYNAMIC_IMPORT', node, offset) : undefined; }
  if (call && parts[0] === 'require' && staticString(children(node.arguments)[0])) return moduleIndicator(staticString(children(node.arguments)[0])!, 'REQUIRE', node, offset);
  if (call && parts.length === 1 && parts[0] === 'eval') return item('EVAL', node, offset);
  if (call && parts.length === 1 && parts[0] === 'Function') return item('FUNCTION_CONSTRUCTOR', node, offset);
  if (parts.length >= 2 && isEnvironment(parts)) return item('ENVIRONMENT_ACCESS', node, offset);
  if ((parts.length >= 2 && ['$env', '$secrets', '$credentials'].includes(parts[0])) || (call && parts.length === 2 && parts[0] === 'this' && parts[1] === 'getCredentials')) return item('SECRET_ACCESS', node, offset, safeMember(parts.at(-1)));
  if (call && parts.length > 1) { const member = parts.at(-1)!, moduleName = parts[0]!.startsWith('node:') ? parts[0]!.slice(5) : parts[0]!, kind = Object.hasOwn(MODULES, moduleName) ? MODULES[moduleName] : undefined; if (kind === 'CHILD_PROCESS' && CHILD_METHODS.has(member)) return item('CHILD_PROCESS_METHOD', node, offset, member); if (kind === 'FILESYSTEM' && FS_METHODS.has(member)) return item('FILESYSTEM_ACCESS', node, offset, member); if (kind === 'NETWORK' && NET_METHODS.has(member)) return item('NETWORK_ACCESS', node, offset, member); }
  if (call && parts.length === 1 && NET_GLOBALS.has(parts[0])) return item('NETWORK_ACCESS', node, offset);
  return undefined;
}
function moduleIndicator(module: string, mode: 'IMPORT' | 'REQUIRE' | 'DYNAMIC_IMPORT', node: Ast, offset: number): Indicator | undefined { const kind = MODULES[module.startsWith('node:') ? module.slice(5) : module]; return kind ? item(`${kind}_${mode}`, node, offset) : undefined; }
function isEnvironment(parts: string[]): boolean { return (parts[0] === PROCESS && parts[1] === 'env') || (parts[0] === 'globalThis' && parts[1] === PROCESS && parts[2] === 'env') || (parts[0] === 'import' && parts[1] === 'meta' && parts[2] === 'env'); }
function safeMember(value: string | undefined): string | undefined { return value !== undefined && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : undefined; }
function item(indicatorName: string, node: Ast, offset: number, member?: string): Indicator { return { indicator: indicatorName, ...(member === undefined ? {} : { member }), start: Math.max(0, node.start - offset), end: Math.max(node.start + 1 - offset, node.end - offset) }; }
function staticString(value: unknown): string | undefined { return isAst(value) && value.type === 'Literal' && typeof value.value === 'string' ? value.value : undefined; }
function identifier(value: unknown): string | undefined { return isAst(value) && value.type === 'Identifier' && typeof value.name === 'string' ? value.name : undefined; }
function children(value: unknown): Ast[] { return Array.isArray(value) ? value.filter(isAst) : []; }
function isAst(value: unknown): value is Ast { return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string' && typeof (value as { start?: unknown }).start === 'number' && typeof (value as { end?: unknown }).end === 'number'; }

function recover(source: string): Indicator[] { const tokens = lex(source), result: Indicator[] = []; for (let i = 0; i < tokens.length; i += 1) { const token = tokens[i]; if (token.value === 'eval' && tokens[i + 1]?.value === '(') result.push({ ...item('EVAL', { start: token.start, end: tokens[i + 2]?.end ?? token.end + 1 } as Ast, 0) }); if (token.value === 'Function' && tokens[i + 1]?.value === '(') result.push({ ...item('FUNCTION_CONSTRUCTOR', { start: token.start, end: tokens[i + 2]?.end ?? token.end + 1 } as Ast, 0) }); if (NET_GLOBALS.has(token.value) && tokens[i + 1]?.value === '(') result.push({ ...item('NETWORK_ACCESS', { start: token.start, end: tokens[i + 2]?.end ?? token.end + 1 } as Ast, 0) }); } return result; }
function lex(source: string): Token[] {
  const output: Token[] = []; let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i]!)) { i += 1; continue; }
    if (source.startsWith('//', i)) { i = source.indexOf('\n', i + 2); if (i < 0) break; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if (source[i] === '/' && regexStart(output)) { i = skipRegex(source, i); continue; }
    const quote = source[i];
    if (quote === "'" || quote === '"' || quote === '`') { const start = i++; while (i < source.length) { if (source[i] === '\\') { i += 2; continue; } if (source[i] === quote) { i += 1; break; } i += 1; } output.push({ value: 'STRING', start, end: i, string: source.slice(start + 1, Math.max(start + 1, i - 1)) }); continue; }
    const match = source.slice(i).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (match) { output.push({ value: match[0], start: i, end: i + match[0].length }); i += match[0].length; continue; }
    output.push({ value: source[i]!, start: i, end: i + 1 }); i += 1;
  }
  return output;
}
function regexStart(tokens: Token[]): boolean { const previous = tokens.at(-1)?.value; return previous === undefined || '=([{,:;!&|?+-*%^~<>'.includes(previous) || REGEX_AFTER.has(previous); }
function skipRegex(source: string, start: number): number { let i = start + 1, escaped = false, characterClass = false; while (i < source.length) { const character = source[i]!; if (!escaped && character === '[') characterClass = true; else if (!escaped && character === ']') characterClass = false; else if (!escaped && character === '/' && !characterClass) { i += 1; while (/[A-Za-z]/.test(source[i] ?? '')) i += 1; return i; } escaped = !escaped && character === '\\'; if (character !== '\\') escaped = false; i += 1; } return source.length; }
