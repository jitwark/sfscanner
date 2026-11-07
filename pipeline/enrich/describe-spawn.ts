import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditGeminiWorkflowInput, projectWorkflowForGemini, projectWorkflowForGeminiRestricted } from './model-safe-workflow';
import type { GeneratedDescription } from '@hub/contracts';
import { invokeAntigravityProxy } from './antigravity-proxy';
import { removePacket, sweepStalePackets } from './omp-packet';

export type SpawnOmpOptions = {
  systemPromptPath: string;
  /** A local, non-workflow correction appended for a model retry. */
  promptHint?: string;
  model?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  ompExe?: string;
  spawnFn?: typeof spawn;
  /** In-memory canaries used to prove source prose did not survive projection. */
  forbiddenSourceTexts?: readonly string[];
  proxyBaseUrl?: string;
  proxyApiKey?: string;
  proxyModel?: string;
  fetchFn?: typeof fetch;
  /** Injectable inputs for stable local packet and prompt names in tests. */
  nowFn?: () => number;
  randomFn?: () => number;
};

export type OmpResponse = GeneratedDescription[];

export type OmpSpawnResult =
  | { ok: true; data: OmpResponse }
  | { ok: false; error: string };

function resolveOmpExe(customExe?: string): string {
  if (customExe) return customExe;
  if (process.platform === 'win32') {
    const bunPath = path.join(os.homedir(), '.bun', 'bin', 'omp.exe');
    if (fs.existsSync(bunPath)) return bunPath;
    return 'omp.exe';
  }
  return 'omp';
}

export async function invokeOmp(
  workflows: unknown[],
  options: SpawnOmpOptions,
): Promise<OmpSpawnResult> {
  const modelWorkflows = workflows.map(projectWorkflowForGemini);
  const audit = auditGeminiWorkflowInput(modelWorkflows, options.forbiddenSourceTexts ? [...options.forbiddenSourceTexts] : []);
  if (!audit.ok) return { ok: false, error: `Model input audit failed: ${audit.errors.join('; ')}` };

  const proxyBaseUrl = options.proxyBaseUrl ?? process.env.ANTIGRAVITY_BASE_URL;
  const proxyApiKey = options.proxyApiKey ?? process.env.ANTIGRAVITY_API_KEY;
  if (proxyBaseUrl || proxyApiKey) {
    const promptText = await fs.promises.readFile(options.systemPromptPath, 'utf8');
    const proxyOptions = {
      baseUrl: proxyBaseUrl ?? '',
      apiKey: proxyApiKey ?? '',
      model: options.proxyModel ?? process.env.ANTIGRAVITY_MODEL ?? 'gemini-3.7-flash-low',
      systemPrompt: options.promptHint?.trim()
        ? `${promptText.trimEnd()}\n\nREVISION INSTRUCTION\n${options.promptHint.trim()}\n`
        : promptText,
      workflows: modelWorkflows,
      timeoutMs: options.timeoutMs ?? 120000,
      maxOutputBytes: options.maxOutputBytes ?? 64 * 1024,
      fetchFn: options.fetchFn,
    };
    let result = await invokeAntigravityProxy({ ...proxyOptions, workflows: modelWorkflows });
    if (!result.ok && result.error === 'Antigravity proxy policy refusal') {
      const restrictedWorkflows = workflows.map(projectWorkflowForGeminiRestricted);
      const restrictedAudit = auditGeminiWorkflowInput(restrictedWorkflows, options.forbiddenSourceTexts ? [...options.forbiddenSourceTexts] : []);
      if (!restrictedAudit.ok) return { ok: false, error: `Restricted model input audit failed: ${restrictedAudit.errors.join('; ')}` };
      result = await invokeAntigravityProxy({ ...proxyOptions, workflows: restrictedWorkflows });
    }
    return result.ok ? { ok: true, data: result.data as OmpResponse } : result;
  }

  const scratchDir = path.resolve(process.cwd(), '.work');
  if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
  }
  await sweepStalePackets(scratchDir);

  // Production fallbacks keep concurrent scratch filenames unique; tests can
  // inject fixed inputs without changing model packet contents.
  const nowFn = options.nowFn ?? (() => Date.now());
  const randomFn = options.randomFn ?? (() => Math.random());
  const temporarySuffix = () => `${nowFn()}-${randomFn().toString(36).slice(2)}`;

  let promptPath = options.systemPromptPath;
  let promptTempPath: string | undefined;
  if (options.promptHint?.trim()) {
    const basePrompt = await fs.promises.readFile(options.systemPromptPath, 'utf8');
    promptTempPath = path.join(
      scratchDir,
      `prompt-${temporarySuffix()}.txt`,
    );
    await fs.promises.writeFile(
      promptTempPath,
      `${basePrompt.trimEnd()}\n\nREVISION INSTRUCTION\n${options.promptHint.trim()}\n`,
      'utf8',
    );
    promptPath = promptTempPath;
  }

  const tempPath = path.join(
    scratchDir,
    `packet-${temporarySuffix()}.json`,
  );
  await fs.promises.writeFile(tempPath, JSON.stringify(modelWorkflows, null, 2), 'utf-8');

  const relPacketPath = path.relative(process.cwd(), tempPath).replace(/\\/g, '/');

  const timeoutMs = options.timeoutMs ?? 120000;
  const maxBytes = options.maxOutputBytes ?? 64 * 1024;
  const exe = resolveOmpExe(options.ompExe);
  const spawnFunc = options.spawnFn || spawn;

  const relSystemPromptPath = path.isAbsolute(promptPath)
    ? path.relative(process.cwd(), promptPath).replace(/\\/g, '/')
    : promptPath;

  const args = [
    '-p',
    '--no-session',
    '--no-tools',
    '--no-extensions',
    '--model',
    options.model || 'google-antigravity/gemini-3.7-flash',
    '--thinking',
    'low',
    '--system-prompt',
    relSystemPromptPath,
    `@${relPacketPath}`,
  ];

  try {
    return await new Promise<OmpSpawnResult>((resolve) => {
      let stdout = '';
      let totalBytes = 0;
      let killed = false;

      const proc = spawnFunc(exe, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });

      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        resolve({ ok: false, error: `Process timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      proc.stdout?.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          killed = true;
          proc.kill('SIGKILL');
          clearTimeout(timer);
          resolve({ ok: false, error: `Output exceeded cap of ${maxBytes} bytes` });
          return;
        }
        stdout += chunk.toString('utf-8');
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        if (!killed) resolve({ ok: false, error: err.message });
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (killed) return;
        if (code !== 0) {
          resolve({ ok: false, error: `Process exited with code ${code}` });
          return;
        }

        try {
          const cleaned = stdout.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
          const parsed = JSON.parse(cleaned) as OmpResponse;
          if (!Array.isArray(parsed)) {
            resolve({ ok: false, error: 'JSON output is not an array' });
            return;
          }
          resolve({ ok: true, data: parsed });
        } catch {
          resolve({ ok: false, error: 'Failed to parse JSON output' });
        }
      });
    });
  } finally {
    await removePacket(tempPath);
    if (promptTempPath) await removePacket(promptTempPath);
  }
}
