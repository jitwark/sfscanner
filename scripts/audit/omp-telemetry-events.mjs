export function createTelemetrySkeleton() {
  const telemetry = {
    session: {
      id: null,
      title: null,
      cwd: null,
      startTime: null,
      endTime: null,
      durationHours: null,
      models: [],
      runtimes: [],
    },
    tools: {
      totalCalls: 0,
      totalResults: 0,
      totalErrors: 0,
      errorRatePct: 0,
      countsByName: {},
      errorsByName: {},
      errorDetails: [],
    },
    tokensAndEfficiency: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalReasoningTokens: 0,
      totalCostUsd: 0,
      thinkingBlocks: 0,
      thinkingCharacters: 0,
      textBlocks: 0,
      textCharacters: 0,
      thinkingToTextRatioChars: 0,
      reasoningToOutputTokenPct: 0,
    },
    churn: {
      bash: { total: 0, unique: 0, repeatRatePct: 0, topCommands: [] },
      reads: { total: 0, unique: 0, repeatRatePct: 0, topFiles: [] },
      edits: { total: 0, unique: 0, topFiles: [], failedCount: 0 },
      writes: { total: 0, unique: 0, topFiles: [] },
    },
    advisor: {
      totalAdviseCalls: 0,
      severityCounts: { blocker: 0, concern: 0, nit: 0, unspecified: 0 },
      injectionsIntoMain: 0,
      topics: {},
      blockers: [],
      keyConcerns: [],
      notes: [],
    },
    subagents: {
      totalSpawnedFiles: 0,
      totalUniqueSubagents: 0,
      archetypes: { writers: 0, reviewers: 0, scouts: 0, others: 0 },
      list: [],
      totalFleetSizeMb: 0,
    },
  };
  return telemetry;
}

export function createMainScanState() {
  const bashCounts = {};
  const readCounts = {};
  const editCounts = {};
  const writeCounts = {};
  const toolCallById = new Map();
  return { bashCounts, readCounts, editCounts, writeCounts, toolCallById };
}

export function applyMainEvent(telemetry, state, obj) {
  const { bashCounts, readCounts, editCounts, writeCounts, toolCallById } = state;
      // Session metadata
      if (obj.type === 'session') {
        telemetry.session.id = obj.id;
        telemetry.session.cwd = obj.cwd;
        telemetry.session.title = obj.title;
        telemetry.session.startTime = obj.timestamp;
      }
      if (obj.timestamp) {
        if (!telemetry.session.startTime) telemetry.session.startTime = obj.timestamp;
        telemetry.session.endTime = obj.timestamp;
      }
      if (obj.type === 'model_change' && obj.model) {
        if (!telemetry.session.models.includes(obj.model)) {
          telemetry.session.models.push(obj.model);
        }
      }

      // Model Usage
      const usage =
        (obj.type === 'message' && obj.message?.role === 'assistant' && obj.message.usage) ||
        (obj.type === 'model_usage' && obj.usage);
      if (usage && (usage.input > 0 || usage.output > 0 || usage.totalTokens > 0)) {
        telemetry.tokensAndEfficiency.totalInputTokens += usage.input || 0;
        telemetry.tokensAndEfficiency.totalOutputTokens += usage.output || 0;
        telemetry.tokensAndEfficiency.totalCacheReadTokens += usage.cacheRead || 0;
        telemetry.tokensAndEfficiency.totalReasoningTokens += usage.reasoningTokens || 0;
        telemetry.tokensAndEfficiency.totalCostUsd += usage.cost?.total || 0;
      }

      // Advisor Injections into Main
      if (obj.type === 'custom_message' && obj.customType === 'advisor') {
        telemetry.advisor.injectionsIntoMain++;
      }

      // Messages & Tools
      if (obj.type === 'message' && obj.message) {
        const msg = obj.message;
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item.type === 'toolCall') {
              telemetry.tools.totalCalls++;
              const name = item.name;
              telemetry.tools.countsByName[name] = (telemetry.tools.countsByName[name] || 0) + 1;
              toolCallById.set(item.id, {
                id: item.id,
                name: item.name,
                arguments: item.arguments,
                timestamp: obj.timestamp,
              });

              if (name === 'bash') {
                const cmd = (item.arguments?.command || '').trim();
                bashCounts[cmd] = (bashCounts[cmd] || 0) + 1;
              } else if (name === 'read') {
                const p = item.arguments?.path;
                readCounts[p] = (readCounts[p] || 0) + 1;
              } else if (name === 'edit') {
                const p = item.arguments?.path;
                editCounts[p] = (editCounts[p] || 0) + 1;
              } else if (name === 'write') {
                const p = item.arguments?.path;
                writeCounts[p] = (writeCounts[p] || 0) + 1;
              }
            } else if (item.type === 'thinking') {
              telemetry.tokensAndEfficiency.thinkingBlocks++;
              telemetry.tokensAndEfficiency.thinkingCharacters += (item.text || item.thinking || '').length;
            } else if (item.type === 'text') {
              telemetry.tokensAndEfficiency.textBlocks++;
              telemetry.tokensAndEfficiency.textCharacters += (item.text || '').length;
            }
          }
        } else if (msg.role === 'toolResult') {
          telemetry.tools.totalResults++;
          if (msg.isError) {
            telemetry.tools.totalErrors++;
            const name = msg.toolName;
            telemetry.tools.errorsByName[name] = (telemetry.tools.errorsByName[name] || 0) + 1;
            const call = toolCallById.get(msg.toolCallId);
            telemetry.tools.errorDetails.push({
              toolName: name,
              toolCallId: msg.toolCallId,
              timestamp: msg.timestamp || obj.timestamp,
              args: call?.arguments,
              details: msg.details,
            });
          }
        }
      }
}

export function applyAdvisorEvent(telemetry, obj) {
        if (obj.type === 'message' && obj.message && obj.message.role === 'assistant') {
          const content = obj.message.content;
          if (Array.isArray(content)) {
            for (const item of content) {
              if (
                (item.type === 'toolCall' || item.type === 'tool_call') &&
                (item.name === 'advise' || item.function?.name === 'advise')
              ) {
                telemetry.advisor.totalAdviseCalls++;
                const args = item.arguments || item.function?.arguments;
                const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
                const severity = parsedArgs.severity || 'unspecified';
                telemetry.advisor.severityCounts[severity] =
                  (telemetry.advisor.severityCounts[severity] || 0) + 1;

                const note = parsedArgs.note || '';
                const entry = {
                  timestamp: obj.timestamp,
                  severity,
                  note,
                };
                telemetry.advisor.notes.push(entry);

                if (severity === 'blocker') {
                  telemetry.advisor.blockers.push(entry);
                } else if (severity === 'concern') {
                  telemetry.advisor.keyConcerns.push(entry);
                }

                // Topic taxonomy
                const lower = note.toLowerCase();
                let topic = 'general_integrity_and_hygiene';
                if (lower.includes('clean') || lower.includes('untracked') || lower.includes('staging')) {
                  topic = 'git_hygiene_and_staging';
                } else if (lower.includes('concurrent') || (lower.includes('while') && lower.includes('writer'))) {
                  topic = 'concurrency_and_freeze';
                } else if (lower.includes('provenance') || lower.includes('slsa') || lower.includes('sourcecommit') || lower.includes('githead')) {
                  topic = 'slsa_and_provenance';
                } else if (lower.includes('windows') || lower.includes('spawn') || lower.includes('npm.cmd') || lower.includes('einval') || lower.includes('enoent')) {
                  topic = 'windows_harness_and_spawning';
                } else if (lower.includes('budget') || lower.includes('capacity') || lower.includes('baseline') || lower.includes('inputsha') || lower.includes('timing')) {
                  topic = 'benchmarks_and_budgets';
                } else if (lower.includes('contract') || lower.includes('schema') || lower.includes('readonly string[]') || lower.includes('digest')) {
                  topic = 'contracts_and_types';
                } else if (lower.includes('q01') || lower.includes('q02') || lower.includes('q03') || lower.includes('q05') || lower.includes('r3') || lower.includes('n1') || lower.includes('n2')) {
                  topic = 'task_and_gate_compliance';
                }
                telemetry.advisor.topics[topic] = (telemetry.advisor.topics[topic] || 0) + 1;
              }
            }
          }
        }
}
