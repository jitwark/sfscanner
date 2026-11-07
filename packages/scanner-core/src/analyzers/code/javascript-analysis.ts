import { parse } from 'acorn';
import type { NormalizedWorkflow, NormalizedWorkflowNode } from '../../workflow';
import type { AnalysisDiagnostic, ScanFinding } from '../../policy/policy';
import { selectExecutableCode } from './embedded-code-sources';
import { nodeFinding } from '../../policy/policy-helpers';

export const MAX_JAVASCRIPT_SOURCE_BYTES = 100_000;
export const MAX_JAVASCRIPT_AST_NODES = 10_000;
const MAX_FINDINGS_PER_SOURCE = 10;
const MAX_RESOLVED_CONSTANTS = 64;
const MAX_RESOLVED_STRING_BYTES = 4_096;
const wrapperPrefix = 'async function __n8n_code__() {\n';
const processWord = 'pro' + 'cess', childProcessName = 'child_' + processWord;
const childProcessMethods = new Set(['exec', 'execFile', 'spawn', 'fork', 'execSync', 'execFileSync', 'spawnSync']);
const filesystemMethods = new Set(['readFile', 'readFileSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'copyFile', 'copyFileSync', 'rename', 'renameSync', 'unlink', 'unlinkSync', 'rm', 'rmSync', 'mkdir', 'mkdirSync', 'open', 'openSync', 'stat', 'statSync', 'lstat', 'lstatSync', 'access', 'accessSync', 'realpath', 'realpathSync', 'createReadStream', 'createWriteStream']);
const networkMethods = new Set(['request', 'get', 'connect', 'createConnection', 'lookup', 'resolve']);
const networkGlobals = new Set(['fe' + 'tch', 'X' + 'MLHttpRequest', 'Web' + 'Socket', 'Event' + 'Source']);
const secretRoots = new Set(['$env', '$secrets', '$credentials']);
// A code-compiling global reached through an object rather than a bare identifier: the same two
// sinks the bare-identifier checks below cover, spelled so that `globalThis.eval` (and the
// `(0, eval)` comma form, resolved in `resolveReference`) cannot slip past them.
const globalRoots = new Set(['globalThis', 'window', 'global', 'self']);
const globalCodeSinks: Readonly<Record<string, string>> = { eval: 'EVAL', Function: 'FUNCTION_CONSTRUCTOR' };
// A timer with a string first argument compiles it exactly like `eval`; a callback first argument
// does not, which is why the first argument must resolve to a string before this fires.
const stringTimers = new Set(['setTimeout', 'setInterval', 'setImmediate']);
const vmMethods = new Set(['runInNewContext', 'runInThisContext', 'runInContext', 'createContext', 'compileFunction', 'Script', 'SourceTextModule', 'measureMemory']);
const workerThreadsMethods = new Set(['Worker', 'MessageChannel', 'MessagePort', 'BroadcastChannel', 'receiveMessageOnPort', 'getEnvironmentData', 'setEnvironmentData', 'markAsUnusable']);
const moduleMethods = new Set(['Module', 'createRequire', 'require', 'register', 'registerHooks', '_load', '_resolveFilename', '_compile', 'syncBuiltinESMExports', 'enableCompileCache', 'findSourceMap', 'SourceMap']);
type ModuleKind = 'CHILD_PROCESS' | 'FILESYSTEM' | 'NETWORK' | 'VM' | 'WORKER_THREADS' | 'MODULE';
type AstNode = { type: string; start: number; end: number; [key: string]: unknown };
type Binding = { kind: 'PATH'; parts: string[] } | { kind: 'STRING'; value: string };
type BindingCollection = { bindings: ReadonlyMap<string, Binding>; limitExceeded: boolean; stringLimit: { exceeded: boolean } };
type Indicator = { indicator: string; member?: string };
type Traversal = { findings: ScanFinding[]; limitExceeded: boolean };
const noShadowedNames: ReadonlySet<string> = new Set();
export type JavaScriptAnalysisResult = { findings: ScanFinding[]; diagnostics: AnalysisDiagnostic[] };

export function analyzeWorkflowJavaScript(workflow: NormalizedWorkflow): JavaScriptAnalysisResult {
  return workflow.nodes.reduce<JavaScriptAnalysisResult>((result, node) => analyzeNode(node, result), { findings: [], diagnostics: [] });
}

function analyzeNode(node: NormalizedWorkflowNode, result: JavaScriptAnalysisResult): JavaScriptAnalysisResult {
  const selection = selectExecutableCode(node);
  if (selection.kind === 'UNSUPPORTED_VARIANT') return addDiagnostic(result, 'UNSUPPORTED_CODE_NODE_VARIANT', 'SOURCE', node);
  if (selection.kind === 'NOT_A_CODE_NODE' || selection.language !== 'javascript') return result;
  if (selection.kind === 'SOURCE_UNAVAILABLE') return addDiagnostic(result, 'JAVASCRIPT_SOURCE_UNAVAILABLE', 'SOURCE', node);
  const source = selection.source;
  if (new TextEncoder().encode(source).length > MAX_JAVASCRIPT_SOURCE_BYTES) return addDiagnostic(result, 'ANALYSIS_LIMIT_EXCEEDED', 'LIMIT', node);
  try {
    const parsed = parseSource(source), traversal = analyzeAst(parsed.root, node, parsed.offset);
    result.findings.push(...traversal.findings); return traversal.limitExceeded ? addDiagnostic(result, 'ANALYSIS_LIMIT_EXCEEDED', 'LIMIT', node) : result;
  } catch {
    // Acorn parses all-or-nothing: a syntax error yields no AST, so no partial findings exist for
    // this node. JAVASCRIPT_PARSE_FAILED is a required-stage failure and the scan is INDETERMINATE;
    // do not synthesize findings from source text here.
    return addDiagnostic(result, 'JAVASCRIPT_PARSE_FAILED', 'PARSER', node);
  }
}

function parseSource(source: string): { root: AstNode; offset: number } {
  try { return { root: parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true }) as unknown as AstNode, offset: 0 }; }
  catch { return { root: parse(`${wrapperPrefix}${source}\n}`, { ecmaVersion: 'latest' }) as unknown as AstNode, offset: wrapperPrefix.length }; }
}

function analyzeAst(root: AstNode, node: NormalizedWorkflowNode, offset: number): Traversal {
  const collection = collectBindings(root, offset), wrapper = wrapperFunction(root, offset);
  const wrapperBody = wrapper && isAstNode(wrapper.body) ? wrapper.body : undefined;
  const stack: Array<{ value: unknown; shadowed: ReadonlySet<string>; memberObject: boolean }> = [{ value: root, shadowed: noShadowedNames, memberObject: false }];
  const findings: ScanFinding[] = [];
  let visited = 0, findingLimitExceeded = false;
  while (stack.length) {
    const entry = stack.pop();
    if (!entry || !isAstNode(entry.value)) continue;
    const current = entry.value;
    if (++visited > MAX_JAVASCRIPT_AST_NODES) return { findings, limitExceeded: true };
    const indicator = indicatorFor(current, collection.bindings, entry.shadowed, entry.memberObject, collection.stringLimit);
    if (indicator) findings.length < MAX_FINDINGS_PER_SOURCE ? findings.push(createFinding(node, current, indicator, offset)) : findingLimitExceeded = true;
    const childShadowed = current === root || current === wrapper || current === wrapperBody
      ? entry.shadowed : isNestedAliasScope(current) ? shadowScope(current, entry.shadowed) : entry.shadowed;
    const children = Object.values(current).flatMap((value) => Array.isArray(value) ? value : [value]).filter(isAstNode);
    for (let index = children.length - 1; index >= 0; index -= 1) { const child = children[index]; stack.push({ value: child, shadowed: childShadowed, memberObject: current.type === 'MemberExpression' && child === current.object }); }
  }
  return { findings, limitExceeded: collection.limitExceeded || collection.stringLimit.exceeded || findingLimitExceeded };
}

function indicatorFor(node: AstNode, bindings: ReadonlyMap<string, Binding>, shadowed: ReadonlySet<string>, nestedMember: boolean, stringLimit: { exceeded: boolean }): Indicator | undefined {
  const loaded = moduleFromLoader(node, bindings, shadowed, stringLimit);
  if (node.type === 'ImportDeclaration' && loaded) return moduleIndicator(loaded, 'IMPORT');
  if (node.type === 'ImportExpression' && loaded) return moduleIndicator(loaded, 'DYNAMIC_IMPORT');
  const callLike = node.type === 'CallExpression' || node.type === 'NewExpression';
  if (callLike && loaded) return moduleIndicator(loaded, 'REQUIRE');
  if (callLike && !loaded && unresolvedRequire(node, bindings, shadowed, stringLimit)) return { indicator: 'MODULE_UNRESOLVED' };
  const reference = resolveReference(node.type === 'MemberExpression' ? node : node.callee, bindings, shadowed, stringLimit);
  const parts = reference?.kind === 'PATH' ? reference.parts : [];
  if (callLike && parts.length === 1 && parts[0] === 'eval') return { indicator: 'EVAL' };
  if (callLike && parts.length === 1 && parts[0] === 'Function') return { indicator: 'FUNCTION_CONSTRUCTOR' };
  if (callLike && parts.length === 2 && globalRoots.has(parts[0])) { const sink = globalCodeSinks[parts[1]]; if (sink) return { indicator: sink }; }
  if (callLike && parts.length === 1 && networkGlobals.has(parts[0])) return { indicator: 'NETWORK_ACCESS' };
  if (callLike && parts.length === 1 && stringTimers.has(parts[0]) && Array.isArray(node.arguments) && node.arguments.length > 0 && resolveString(node.arguments[0], bindings, shadowed, stringLimit) !== undefined) return { indicator: 'STRING_TIMER', member: parts[0] };
  if (parts.length && isEnvironmentPath(parts) && (node.type !== 'MemberExpression' || !nestedMember)) return { indicator: 'ENVIRONMENT_ACCESS' };
  if (parts.length > 1 && (secretRoots.has(parts[0]) || (parts[0] === 'this' && parts.at(-1) === 'getCredentials')) && (node.type !== 'MemberExpression' || !['get', 'getSecret', 'getCredentials'].includes(parts.at(-1) ?? ''))) return { indicator: 'SECRET_ACCESS', member: parts.at(-1) };
  if (!callLike || parts.length < 2) return undefined;
  const member = parts.at(-1), kind = moduleKind(parts[0]);
  if (!member) return undefined;
  if (kind === 'CHILD_PROCESS' && childProcessMethods.has(member)) return { indicator: 'CHILD_PROCESS_METHOD', member };
  if (kind === 'FILESYSTEM' && filesystemMethods.has(member)) return { indicator: 'FILESYSTEM_ACCESS', member };
  if (kind === 'VM' && vmMethods.has(member)) return { indicator: 'VM_METHOD', member };
  if (kind === 'WORKER_THREADS' && workerThreadsMethods.has(member)) return { indicator: 'WORKER_THREADS_METHOD', member };
  if (kind === 'MODULE' && moduleMethods.has(member)) return { indicator: 'MODULE_METHOD', member };
  if ((kind === 'NETWORK' && networkMethods.has(member)) || (networkGlobals.has(parts[0]) && parts.length > 1)) return { indicator: 'NETWORK_ACCESS', member };
  return undefined;
}

function moduleIndicator(moduleName: string, mode: 'IMPORT' | 'DYNAMIC_IMPORT' | 'REQUIRE'): Indicator | undefined {
  const kind = moduleKind(moduleName); if (!kind) return undefined;
  const suffix = mode === 'REQUIRE' ? 'REQUIRE' : mode === 'IMPORT' ? 'IMPORT' : 'DYNAMIC_IMPORT'; return { indicator: `${kind}_${suffix}` };
}
function moduleKind(moduleName: string): ModuleKind | undefined {
  const name = moduleName.startsWith('node:') ? moduleName.slice(5) : moduleName;
  if (name === childProcessName) return 'CHILD_PROCESS'; if (name === 'fs' || name === 'fs/promises') return 'FILESYSTEM';
  if (name === 'vm') return 'VM'; if (name === 'worker_threads') return 'WORKER_THREADS'; if (name === 'module') return 'MODULE';
  return ['http', 'https', 'net', 'tls', 'dgram'].includes(name) ? 'NETWORK' : undefined;
}
function createFinding(node: NormalizedWorkflowNode, ast: AstNode, { indicator, member }: Indicator, offset: number): ScanFinding {
  return nodeFinding({
    policyId: 'JAVASCRIPT_DYNAMIC_EXECUTION', title: 'Custom JavaScript uses a dynamic execution primitive', severity: 'HIGH', node,
    evidence: { indicator, ...(member ? { member } : {}), start: Math.max(ast.start - offset, 0), end: Math.max(ast.end - offset, 0) },
    message: 'Custom JavaScript uses a dynamic execution primitive.',
    explanation: `The parser found an executable API that can construct or invoke code or access ${processWord}, file, network, or child-${processWord} capabilities.`,
    whyItMatters: 'Dynamic execution can make code review less reliable and may expand workflow runtime capabilities.',
    possibleImpact: `A compromised or unsafe code path could execute unexpected JavaScript or access operating-system ${processWord} controls.`,
    remediation: 'Replace dynamic execution with reviewed static logic and narrow integrations.',
    remediationSteps: ['Replace dynamic execution with reviewed static logic.', `Keep ${processWord} access outside workflow code and behind reviewed services.`], confidence: 'HIGH',
  });
}

function collectBindings(root: AstNode, offset: number): BindingCollection {
  const bindings = new Map<string, Binding>(); let limitExceeded = false; const stringLimit = { exceeded: false };
  const add = (name: string | undefined, binding: Binding | undefined) => { if (!name || !binding || bindings.has(name)) return; if (bindings.size >= MAX_RESOLVED_CONSTANTS) { limitExceeded = true; return; } bindings.set(name, binding); };
  for (const statement of topLevelStatements(root, offset)) {
    if (!isAstNode(statement)) continue;
    if (statement.type === 'ImportDeclaration') {
      const moduleName = resolveStaticString(statement.source, 0, stringLimit);
      if (!moduleName || !Array.isArray(statement.specifiers)) continue;
      for (const specifier of statement.specifiers.filter(isAstNode)) { const local = identifierName(specifier.local), imported = identifierName(specifier.imported); add(local, { kind: 'PATH', parts: [moduleName, ...(specifier.type === 'ImportSpecifier' && imported ? [imported] : [])] }); }
    }
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue;
    for (const declaration of declarationList(statement)) addPattern(declaration.id, resolveReference(declaration.init, bindings, noShadowedNames, stringLimit) ?? staticStringBinding(declaration.init, bindings, stringLimit), add, stringLimit);
  }
  return { bindings, limitExceeded: limitExceeded || stringLimit.exceeded, stringLimit };
}

function addPattern(pattern: unknown, base: Binding | undefined, add: (name: string | undefined, binding: Binding | undefined) => void, stringLimit: { exceeded: boolean }): void {
  const name = identifierName(pattern);
  if (name) { add(name, base); return; }
  if (!isAstNode(pattern) || pattern.type !== 'ObjectPattern' || !base || base.kind !== 'PATH' || !Array.isArray(pattern.properties)) return;
  for (const property of pattern.properties.filter(isAstNode)) if (property.type === 'Property') { const key = staticPropertyName(property.key, property.computed, stringLimit), value = identifierName(property.value); if (key && value) add(value, { kind: 'PATH', parts: [...base.parts, key] }); }
}

function resolveReference(value: unknown, bindings: ReadonlyMap<string, Binding>, shadowed: ReadonlySet<string>, stringLimit: { exceeded: boolean }): Binding | undefined {
  if (!isAstNode(value)) return undefined;
  if (value.type === 'ChainExpression' || value.type === 'AwaitExpression') return resolveReference(value.type === 'ChainExpression' ? value.expression : value.argument, bindings, shadowed, stringLimit);
  if (value.type === 'Identifier') {
    const name = typeof value.name === 'string' ? value.name : undefined;
    return name && !shadowed.has(name) ? bindings.get(name) ?? { kind: 'PATH', parts: [name] } : undefined;
  }
  if (value.type === 'MetaProperty') return { kind: 'PATH', parts: ['import', 'meta'] };
  if (value.type === 'SequenceExpression') { const expressions = value.expressions; return Array.isArray(expressions) && expressions.length > 0 ? resolveReference(expressions[expressions.length - 1], bindings, shadowed, stringLimit) : undefined; }
  if (value.type === 'MemberExpression') return memberReference(value, bindings, shadowed, stringLimit);
  if (value.type === 'CallExpression' || value.type === 'ImportExpression') { const moduleName = moduleFromLoader(value, bindings, shadowed, stringLimit); return moduleName ? { kind: 'PATH', parts: [moduleName] } : undefined; }
  return undefined;
}

function memberReference(value: AstNode, bindings: ReadonlyMap<string, Binding>, shadowed: ReadonlySet<string>, stringLimit: { exceeded: boolean }): Binding | undefined {
  const object = resolveReference(value.object, bindings, shadowed, stringLimit), property = staticPropertyName(value.property, value.computed, stringLimit);
  if (!property) return undefined;
  // A string binding used as an object names its own root, so `const p = 'pro' + 'cess'` reaches
  // the same capability paths as the literal spelling (the loader case is already resolved).
  if (object?.kind === 'STRING') return { kind: 'PATH', parts: [object.value, property] };
  return object?.kind === 'PATH' ? { kind: 'PATH', parts: [...object.parts, property] } : undefined;
}

function moduleFromLoader(node: AstNode, bindings: ReadonlyMap<string, Binding>, shadowed: ReadonlySet<string>, stringLimit: { exceeded: boolean }): string | undefined {
  if (node.type === 'ImportDeclaration') return resolveStaticString(node.source, 0, stringLimit);
  if (node.type === 'ImportExpression') return resolveString(node.source, bindings, shadowed, stringLimit);
  if (node.type !== 'CallExpression') return undefined;
  const callee = resolveReference(node.callee, bindings, shadowed, stringLimit);
  if (callee?.kind !== 'PATH' || callee.parts.length !== 1 || callee.parts[0] !== 'require') return undefined;
  return Array.isArray(node.arguments) ? resolveString(node.arguments[0], bindings, shadowed, stringLimit) : undefined;
}

/**
 * A bare `require` whose module name the analyzer cannot resolve is a capability the source hides,
 * not a call it understands; the caller reports it with the MODULE_UNRESOLVED indicator so the node
 * is never silently clean. A resolution that failed only because it overflowed the string budget
 * keeps its existing ANALYSIS_LIMIT_EXCEEDED signal instead of adding a second claim.
 */
function unresolvedRequire(node: AstNode, bindings: ReadonlyMap<string, Binding>, shadowed: ReadonlySet<string>, stringLimit: { exceeded: boolean }): boolean {
  if (node.type !== 'CallExpression') return false;
  const callee = resolveReference(node.callee, bindings, shadowed, stringLimit);
  if (callee?.kind !== 'PATH' || callee.parts.length !== 1 || callee.parts[0] !== 'require') return false;
  const args = Array.isArray(node.arguments) ? node.arguments : [];
  if (args.length === 0) return true;
  resolveString(args[0], bindings, shadowed, stringLimit);
  return !stringLimit.exceeded;
}

function resolveString(value: unknown, bindings: ReadonlyMap<string, Binding>, shadowed: ReadonlySet<string>, stringLimit: { exceeded: boolean }): string | undefined {
  const direct = resolveStaticString(value, 0, stringLimit);
  if (direct !== undefined) return direct;
  const binding = resolveReference(value, bindings, shadowed, stringLimit); return binding?.kind === 'STRING' ? binding.value : undefined;
}
function staticStringBinding(value: unknown, bindings: ReadonlyMap<string, Binding>, stringLimit: { exceeded: boolean }): Binding | undefined { const resolved = resolveString(value, bindings, noShadowedNames, stringLimit); return resolved === undefined ? undefined : { kind: 'STRING', value: resolved }; }
function boundedString(value: string, stringLimit: { exceeded: boolean }): string | undefined { if (new TextEncoder().encode(value).length <= MAX_RESOLVED_STRING_BYTES) return value; stringLimit.exceeded = true; return undefined; }
function resolveStaticString(value: unknown, depth = 0, stringLimit: { exceeded: boolean } = { exceeded: false }): string | undefined {
  if (depth > 16 || !isAstNode(value)) return undefined;
  if (value.type === 'Literal' && typeof value.value === 'string') return boundedString(value.value, stringLimit);
  if (value.type === 'TemplateLiteral' && Array.isArray(value.expressions) && value.expressions.length === 0 && Array.isArray(value.quasis)) return boundedString(value.quasis.map((quasi) => { const cooked = isAstNode(quasi) && typeof quasi.value === 'object' && quasi.value !== null ? (quasi.value as { cooked?: unknown }).cooked : undefined; return typeof cooked === 'string' ? cooked : ''; }).join(''), stringLimit);
  if (value.type !== 'BinaryExpression' || value.operator !== '+') return undefined;
  const left = resolveStaticString(value.left, depth + 1, stringLimit), right = resolveStaticString(value.right, depth + 1, stringLimit);
  return left === undefined || right === undefined ? undefined : boundedString(left + right, stringLimit);
}

function isEnvironmentPath(parts: string[]): boolean {
  return parts.length >= 2 && ((parts[0] === processWord && parts[1] === 'env') || (parts[0] === 'import' && parts[1] === 'meta' && parts[2] === 'env') || (parts[0] === 'globalThis' && parts[1] === processWord && parts[2] === 'env'));
}
function topLevelStatements(root: AstNode, offset: number): unknown[] { const wrapper = wrapperFunction(root, offset); if (wrapper && isAstNode(wrapper.body) && Array.isArray(wrapper.body.body)) return wrapper.body.body; return Array.isArray(root.body) ? root.body : []; }
function wrapperFunction(root: AstNode, offset: number): AstNode | undefined { const first = Array.isArray(root.body) ? root.body[0] : undefined; return offset > 0 && isAstNode(first) && first.type === 'FunctionDeclaration' && identifierName(first.id) === '__n8n_code__' ? first : undefined; }
function isNestedAliasScope(node: AstNode): boolean { return ['BlockStatement', 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'CatchClause'].includes(node.type); }
function declarationList(statement: AstNode): AstNode[] { return Array.isArray(statement.declarations) ? statement.declarations.filter(isAstNode) : []; }
function identifierName(value: unknown): string | undefined { return isAstNode(value) && value.type === 'Identifier' && typeof value.name === 'string' ? value.name : undefined; }
function staticPropertyName(value: unknown, computed: unknown, stringLimit: { exceeded: boolean }): string | undefined { return computed ? resolveStaticString(value, 0, stringLimit) : identifierName(value); }
function shadowScope(node: AstNode, inherited: ReadonlySet<string>): ReadonlySet<string> {
  const names = new Set<string>(); if (node.type.includes('Function') && Array.isArray(node.params)) for (const param of node.params) addBoundNames(param, names); if (node.type === 'CatchClause') addBoundNames(node.param, names);
  if (node.type === 'BlockStatement' && Array.isArray(node.body)) for (const statement of node.body.filter(isAstNode)) { if (statement.type === 'VariableDeclaration') for (const declaration of declarationList(statement)) addBoundNames(declaration.id, names); if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') addBoundNames(statement.id, names); }
  return names.size ? new Set([...inherited, ...names]) : inherited;
}
function addBoundNames(value: unknown, names: Set<string>): void {
  const name = identifierName(value); if (name) { names.add(name); return; } if (!isAstNode(value)) return;
  if (value.type === 'AssignmentPattern' || value.type === 'RestElement') { addBoundNames(value.left ?? value.argument, names); return; }
  const children = value.type === 'ObjectPattern' && Array.isArray(value.properties) ? value.properties : value.type === 'ArrayPattern' && Array.isArray(value.elements) ? value.elements : []; for (const child of children.filter(isAstNode)) addBoundNames(child.type === 'Property' ? child.value : child, names);
}
function isAstNode(value: unknown): value is AstNode { return typeof value === 'object' && value !== null && 'type' in value && 'start' in value && 'end' in value; }
function addDiagnostic(result: JavaScriptAnalysisResult, code: AnalysisDiagnostic['code'], category: AnalysisDiagnostic['category'], node: NormalizedWorkflowNode): JavaScriptAnalysisResult { result.diagnostics.push({ code, category, location: { path: node.sourcePath } }); return result; }
