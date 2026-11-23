/**
 * Main orchestrator.
 *
 * One Agent SDK query() session:
 *   1. fetches the PR through the GitHub MCP server,
 *   2. spawns the three subagents in parallel with the Task tool,
 *   3. aggregates their findings into a ReviewReport enforced by outputFormat (JSON Schema
 *      generated from the Zod schema) and re-validated with Zod safeParse.
 *
 * Reliability: the whole review is rate limited, wrapped in a timeout (the SDK process is
 * aborted when it fires) and retried with exponential backoff on transient failures.
 * Subagent failures are handled inside the session (see orchestrator prompt, Step 4), so
 * one failed subagent still produces a report.
 *
 * Integration check (Part 1/2): `npm run dev -- octocat Hello-World 1` runs this class
 * against a real public PR; tests/integration.test.ts does the same when RUN_INTEGRATION=1.
 */
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { z } from 'zod';
import { SUBAGENT_NAMES, subagents } from './agents/index.js';
import { ALL_MCP_TOOLS, getMcpServers, MCP_SERVER_NAMES } from './config/mcp.config.js';
import { buildOrchestratorPrompt, ORCHESTRATOR_SYSTEM_PROMPT } from './prompts/index.js';
import { ReviewReportSchema } from './types/index.js';
import { ErrorCodes, errorMessage, ReviewError, withRetry, withTimeout } from './utils/error-handler.js';
import { toSdkJsonSchema } from './utils/json-schema.js';
import { logger } from './utils/logger.js';
import { RateLimiter } from './utils/rate-limiter.js';

export type ReviewReport = z.infer<typeof ReviewReportSchema>;

type ResultMessage = Extract<SDKMessage, { type: 'result' }>;
type McpServerStatus = { name: string; status: string };

export interface OrchestratorConfig {
  /** Defaults to process.env.ANTHROPIC_MODEL (never hard-coded). */
  model?: string;
  /** Working directory for the agent; must contain .claude/skills. Defaults to PROJECT_ROOT or cwd. */
  projectRoot?: string;
  maxTurns?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  estimatedTokensPerReview?: number;
  rateLimiter?: RateLimiter;
}

/** Tool names for the subagent spawner: "Task" (SDK <= 0.1.x) and "Agent" (newer releases). */
const SUBAGENT_TOOLS = ['Task', 'Agent'] as const;

/**
 * Tools auto-approved for the session: the subagent spawner, every MCP tool derived from the
 * server config, plus the read-only built-ins and Skill that the subagents use.
 */
export const ORCHESTRATOR_ALLOWED_TOOLS: string[] = [
  ...SUBAGENT_TOOLS,
  ...ALL_MCP_TOOLS,
  'Skill',
  'Read',
  'Grep',
  'Glob',
];

/** Never needed for a review; removed so no agent can modify files or run commands. */
const DISALLOWED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch'];

const DEFAULTS = {
  maxTurns: 60,
  timeoutMs: 20 * 60_000,
  maxRetries: 2,
  retryDelayMs: 5_000,
  estimatedTokensPerReview: 150_000,
};

const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Fallback when the result carries JSON text instead of structured_output. */
function parseJsonFromText(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

export class Orchestrator {
  private readonly model: string;
  private readonly projectRoot: string;
  private readonly maxTurns: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly estimatedTokens: number;
  private readonly rateLimiter: RateLimiter;

  constructor(config: OrchestratorConfig = {}) {
    const model = config.model ?? process.env.ANTHROPIC_MODEL;
    if (!model) {
      throw new ReviewError(
        'ANTHROPIC_MODEL environment variable is required (e.g. claude-sonnet-4-5-20250929).',
        ErrorCodes.CONFIGURATION_ERROR,
      );
    }
    this.model = model;
    this.projectRoot = config.projectRoot ?? process.env.PROJECT_ROOT ?? process.cwd();
    this.maxTurns = config.maxTurns ?? DEFAULTS.maxTurns;
    this.timeoutMs = config.timeoutMs ?? numberFromEnv('REVIEW_TIMEOUT_MS') ?? DEFAULTS.timeoutMs;
    this.maxRetries = config.maxRetries ?? DEFAULTS.maxRetries;
    this.retryDelayMs = config.retryDelayMs ?? DEFAULTS.retryDelayMs;
    this.estimatedTokens = config.estimatedTokensPerReview ?? DEFAULTS.estimatedTokensPerReview;
    this.rateLimiter = config.rateLimiter ?? new RateLimiter();
  }

  /** Reviews one PR and returns a Zod-validated ReviewReport. */
  async reviewPullRequest(owner: string, repo: string, prNumber: number): Promise<ReviewReport> {
    if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo)) {
      throw new ReviewError(`Invalid repository "${owner}/${repo}".`, ErrorCodes.INVALID_INPUT);
    }
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new ReviewError(`PR number must be a positive integer (got ${prNumber}).`, ErrorCodes.INVALID_INPUT);
    }

    const label = `${owner}/${repo}#${prNumber}`;
    await this.rateLimiter.acquire(this.estimatedTokens);
    try {
      return await withRetry(() => this.runWithTimeout(owner, repo, prNumber, label), {
        maxRetries: this.maxRetries,
        delayMs: this.retryDelayMs,
        onRetry: (error, attempt, delay) =>
          logger.warn(
            `Review attempt ${attempt} for ${label} failed: ${errorMessage(error)} ` +
              `-> retrying in ${Math.round(delay / 1000)}s`,
          ),
      });
    } finally {
      this.rateLimiter.release();
    }
  }

  private async runWithTimeout(owner: string, repo: string, prNumber: number, label: string): Promise<ReviewReport> {
    const abortController = new AbortController();
    try {
      return await withTimeout(
        () => this.runReview(owner, repo, prNumber, label, abortController),
        this.timeoutMs,
        `Review of ${label}`,
      );
    } catch (error) {
      abortController.abort(); // stop the SDK subprocess so a timed-out attempt cannot keep running
      throw error;
    }
  }

  private buildQueryOptions(abortController: AbortController): Options {
    return {
      model: this.model,
      cwd: this.projectRoot,
      systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
      mcpServers: getMcpServers(),
      agents: subagents,
      allowedTools: ORCHESTRATOR_ALLOWED_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
      // Unattended CI/CD run: no human is available to approve tool calls. Safety comes from
      // the read-only tool lists above and the disallowed write/exec tools.
      permissionMode: 'bypassPermissions',
      // Load project settings so .claude/skills/* is discovered for the Skill tool.
      settingSources: ['project'],
      maxTurns: this.maxTurns,
      outputFormat: {
        type: 'json_schema',
        schema: toSdkJsonSchema(ReviewReportSchema),
      },
      abortController,
    };
  }

  private async runReview(
    owner: string,
    repo: string,
    prNumber: number,
    label: string,
    abortController: AbortController,
  ): Promise<ReviewReport> {
    const startedAt = Date.now();
    const invokedSubagents = new Set<string>();
    const pendingSubagents = new Map<string, string>(); // tool_use_id -> subagent name
    let result: ResultMessage | undefined;

    logger.info(`Starting review of ${label} (model: ${this.model})`);

    for await (const message of query({
      prompt: buildOrchestratorPrompt({ owner, repo, prNumber }),
      options: this.buildQueryOptions(abortController),
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        this.checkMcpServers(message.mcp_servers);
      }
      this.trackProgress(message, invokedSubagents, pendingSubagents);
      if (message.type === 'result') {
        result = message;
      }
    }

    if (!result) {
      throw new ReviewError('The agent session ended without a result message.', ErrorCodes.AGENT_FAILURE);
    }

    logger.info(
      `Session finished: ${result.subtype}, ${result.num_turns} turns, ` +
        `${((Date.now() - startedAt) / 1000).toFixed(0)}s, cost $${result.total_cost_usd.toFixed(4)}`,
    );

    if (result.subtype !== 'success') {
      // Plain string so this compiles with SDK versions that have different error subtypes.
      const subtype: string = result.subtype;
      throw new ReviewError(
        `The orchestrator did not complete successfully (${subtype}).`,
        subtype === 'error_max_structured_output_retries' ? ErrorCodes.VALIDATION_ERROR : ErrorCodes.AGENT_FAILURE,
        { subtype },
      );
    }

    const missing = SUBAGENT_NAMES.filter((name) => !invokedSubagents.has(name));
    if (missing.length > 0) {
      logger.warn(`Report produced, but these subagents were never invoked: ${missing.join(', ')}`);
    }

    const raw = result.structured_output ?? parseJsonFromText(result.result);
    const parsed = ReviewReportSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ReviewError(
        `The final report does not match the ReviewReport schema: ${formatZodIssues(parsed.error)}`,
        ErrorCodes.VALIDATION_ERROR,
        parsed.error.issues,
      );
    }

    logger.info(`Review of ${label} validated against ReviewReportSchema`);
    return parsed.data;
  }

  /** Fails fast when GitHub is unreachable (no PR data means no review); ESLint is optional. */
  private checkMcpServers(servers: McpServerStatus[]): void {
    for (const server of servers) {
      if (server.status === 'connected') {
        logger.info(`MCP server "${server.name}" connected`);
        continue;
      }
      if (server.name === MCP_SERVER_NAMES.github) {
        throw new ReviewError(
          `GitHub MCP server failed to start (status: ${server.status}). ` +
            'Check GITHUB_TOKEN in .env and that npx can download @modelcontextprotocol/server-github.',
          ErrorCodes.MCP_CONNECTION_ERROR,
          server,
        );
      }
      logger.warn(`MCP server "${server.name}" not available (status: ${server.status}); continuing without it`);
    }
  }

  /** Logs subagent spawns/completions and skill usage so the CLI shows progress. */
  private trackProgress(
    message: SDKMessage,
    invokedSubagents: Set<string>,
    pendingSubagents: Map<string, string>,
  ): void {
    if (message.type === 'assistant') {
      const origin = message.parent_tool_use_id ? 'subagent' : 'orchestrator';
      for (const block of message.message.content) {
        if (block.type !== 'tool_use') continue;
        const input = (block.input ?? {}) as Record<string, unknown>;

        if ((SUBAGENT_TOOLS as readonly string[]).includes(block.name)) {
          const name = String(input.subagent_type ?? 'unknown');
          invokedSubagents.add(name);
          pendingSubagents.set(block.id, name);
          logger.info(`-> Spawning subagent: ${name}`);
        } else if (block.name === 'Skill') {
          logger.info(`   Skill invoked by ${origin}: ${String(input.skill ?? input.command ?? 'unknown')}`);
        } else if (block.name.startsWith('mcp__')) {
          logger.debug(`   ${origin} called ${block.name}`);
        }
      }
      return;
    }

    if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type !== 'tool_result') continue;
        const name = pendingSubagents.get(block.tool_use_id);
        if (!name) continue;
        pendingSubagents.delete(block.tool_use_id);
        if (block.is_error) {
          logger.warn(`<- Subagent ${name} reported an error (the orchestrator will retry or degrade)`);
        } else {
          logger.info(`<- Subagent ${name} finished`);
        }
      }
    }
  }
}
