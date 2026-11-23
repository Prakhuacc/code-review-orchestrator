/**
 * CLI entry point.
 *
 *   npm run dev -- <owner> <repo> <pr-number>
 *   npm run dev -- udacity cd14715-simple-todo-app 1
 *
 * Validates arguments and environment, runs the multi-agent review and writes
 * reports/<owner>_<repo>_<pr>.{json,md,html} with the provided ReportGenerator.
 */
import { config as loadEnv } from 'dotenv';
import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Orchestrator, type ReviewReport } from './orchestrator.js';
import { ErrorCodes, errorMessage, ReviewError } from './utils/error-handler.js';
import { logger } from './utils/logger.js';
import { ReportGenerator } from './utils/report-generator.js';
loadEnv({ override: true }); // .env wins over workspace defaults (e.g. ANTHROPIC_MODEL)

const USAGE = `
Usage:
  npm run dev -- <owner> <repo> <pr-number>

Examples:
  npm run dev -- udacity cd14715-simple-todo-app 1
  npm run dev -- octocat Hello-World 1
`;

const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;

/** Errors whose message is already written for the user (no stack trace needed). */
class CliError extends Error {}

interface CliArgs {
  owner: string;
  repo: string;
  prNumber: number;
}

type AuthMethod = 'anthropic-api' | 'aws-bedrock';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** argv is process.argv.slice(2): argv[0] of the process is node, argv[1] the script. */
function parseArgs(argv: string[]): CliArgs {
  if (argv.length < 3) {
    const missing = ['owner', 'repo', 'pr-number'].slice(argv.length).join(', ');
    throw new CliError(`Missing required argument(s): ${missing}.\n${USAGE}`);
  }
  if (argv.length > 3) {
    throw new CliError(`Too many arguments: expected 3, got ${argv.length}.\n${USAGE}`);
  }

  const [owner, repo, prRaw] = argv as [string, string, string];
  if (!GITHUB_NAME.test(owner)) {
    throw new CliError(`Invalid owner "${owner}". Use the GitHub user or organization name, e.g. "udacity".`);
  }
  if (!GITHUB_NAME.test(repo)) {
    throw new CliError(`Invalid repository "${repo}". Use only the repository name, e.g. "cd14715-simple-todo-app".`);
  }
  if (!/^\d+$/.test(prRaw)) {
    throw new CliError(`PR number must be a positive integer, got "${prRaw}".\n${USAGE}`);
  }
  const prNumber = Number.parseInt(prRaw, 10);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new CliError(`PR number must be a positive integer, got "${prRaw}".`);
  }
  return { owner, repo, prNumber };
}

function looksLikePlaceholder(value: string): boolean {
  return /your[-_]?(api[-_]?)?key|your-key-here|<paste|changeme|xxxxx/i.test(value);
}

/** Requires ANTHROPIC_API_KEY or AWS credentials (+ region). Never logs secret values. */
function validateAuthentication(): AuthMethod {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const awsAccessKey = process.env.AWS_ACCESS_KEY_ID?.trim();
  const awsSecret = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  const awsRegion = process.env.AWS_REGION?.trim();

  if (apiKey) {
    if (looksLikePlaceholder(apiKey)) {
      throw new CliError(
        'ANTHROPIC_API_KEY looks like a placeholder value.\n' +
          'In Vocareum the key is pre-set in the shell; remove ANTHROPIC_API_KEY from .env, or paste your real key.',
      );
    }
    const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
    logger.info(`Authentication: Anthropic API key${baseUrl ? ` (custom endpoint ${baseUrl})` : ''}`);
    return 'anthropic-api';
  }

  if (awsAccessKey && awsSecret) {
    if (!awsRegion) {
      throw new CliError(
        'AWS credentials were found but AWS_REGION is not set.\nAdd it to .env, for example: AWS_REGION=us-east-1',
      );
    }
    if (!process.env.CLAUDE_CODE_USE_BEDROCK) {
      process.env.CLAUDE_CODE_USE_BEDROCK = '1'; // tells the Agent SDK to route through Bedrock
    }
    logger.info(`Authentication: AWS Bedrock (region ${awsRegion})`);
    return 'aws-bedrock';
  }

  if (awsAccessKey || awsSecret) {
    throw new CliError(
      'Incomplete AWS credentials: both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required (plus AWS_REGION).',
    );
  }

  throw new CliError(
    'No authentication configured. Set ONE of the following:\n\n' +
      '  Option 1 - Anthropic API (default in the Vocareum workspace):\n' +
      '    ANTHROPIC_API_KEY=sk-ant-...\n\n' +
      '  Option 2 - Amazon Bedrock:\n' +
      '    AWS_ACCESS_KEY_ID=...\n' +
      '    AWS_SECRET_ACCESS_KEY=...\n' +
      '    AWS_REGION=us-east-1\n\n' +
      'In Vocareum you can check the key with: echo $ANTHROPIC_API_KEY | head -c 10',
  );
}

function validateModel(authMethod: AuthMethod): string {
  const model = process.env.ANTHROPIC_MODEL?.trim();
  if (!model) {
    throw new CliError(
      'ANTHROPIC_MODEL environment variable is required. Add it to .env:\n\n' +
        '  Anthropic API: ANTHROPIC_MODEL=claude-sonnet-4-5-20250929\n' +
        '  AWS Bedrock:   ANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    );
  }
  const looksLikeBedrockId = model.includes('anthropic.');
  if (authMethod === 'aws-bedrock' && !looksLikeBedrockId) {
    logger.warn(`ANTHROPIC_MODEL "${model}" does not look like a Bedrock model ID (e.g. us.anthropic.claude-...).`);
  }
  if (authMethod === 'anthropic-api' && looksLikeBedrockId) {
    logger.warn(`ANTHROPIC_MODEL "${model}" looks like a Bedrock ID; the Anthropic API expects e.g. claude-sonnet-4-5-20250929.`);
  }
  return model;
}

function validateProjectRoot(): string {
  const projectRoot = process.env.PROJECT_ROOT?.trim();
  if (!projectRoot) {
    throw new CliError(
      'PROJECT_ROOT is required. Add the absolute path of project/starter to .env, for example:\n' +
        '  PROJECT_ROOT=/voc/work/project/starter',
    );
  }
  if (!path.isAbsolute(projectRoot) || !existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
    throw new CliError(`PROJECT_ROOT "${projectRoot}" must be an absolute path to an existing directory.`);
  }
  if (!existsSync(path.join(projectRoot, '.claude', 'skills'))) {
    logger.warn(`No .claude/skills directory under PROJECT_ROOT (${projectRoot}); subagents will run without Claude Skills.`);
  }
  return projectRoot;
}

function checkGitHubToken(): void {
  if (!process.env.GITHUB_TOKEN?.trim()) {
    logger.warn(
      'GITHUB_TOKEN is not set. Public repositories may still work, but you can hit GitHub rate limits ' +
        'or the GitHub MCP server may refuse to start. Create a token at https://github.com/settings/tokens.',
    );
  }
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

async function saveReports(report: ReviewReport, args: CliArgs, projectRoot: string): Promise<string[]> {
  const reportsDir = path.join(projectRoot, 'reports');
  await mkdir(reportsDir, { recursive: true });

  const baseName = `${args.owner}_${args.repo}_${args.prNumber}`;
  const generator = new ReportGenerator();

  const outputs: Array<[string, string]> = [
    [`${baseName}.json`, await generator.generateJSONReport(report)],
    [`${baseName}.md`, await generator.generateMarkdownReport(report)],
    [`${baseName}.html`, await generator.generateHTMLReport(report)],
  ];

  const written: string[] = [];
  for (const [fileName, content] of outputs) {
    if (!content || content.trim().length === 0) {
      throw new CliError(`ReportGenerator produced an empty ${path.extname(fileName)} report.`);
    }
    if (/\bundefined\b/.test(content)) {
      logger.warn(`${fileName} contains the text "undefined"; check that every report field is populated.`);
    }
    const filePath = path.join(reportsDir, fileName);
    await writeFile(filePath, content, 'utf8');
    written.push(filePath);
  }
  return written;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const HINTS: Partial<Record<ErrorCodes, string>> = {
  [ErrorCodes.MCP_CONNECTION_ERROR]:
    'Set a valid GITHUB_TOKEN in .env and make sure npx can reach the npm registry.',
  [ErrorCodes.TIMEOUT]: 'The review took too long. Try again, or raise REVIEW_TIMEOUT_MS in .env (milliseconds).',
  [ErrorCodes.VALIDATION_ERROR]:
    'The agents returned data that does not match the ReviewReport schema. Re-run, or set LOG_LEVEL=debug to inspect.',
  [ErrorCodes.AGENT_FAILURE]: 'The agent session stopped early. Re-run with LOG_LEVEL=debug for details.',
  [ErrorCodes.RETRY_EXHAUSTED]: 'All retries failed; the underlying cause is shown above.',
  [ErrorCodes.INVALID_INPUT]: 'Check the owner, repo and PR number arguments.',
  [ErrorCodes.CONFIGURATION_ERROR]: 'Check your .env file (see .env.example).',
};

function printFriendlyError(error: unknown): void {
  if (error instanceof CliError) {
    console.error(`\nError: ${error.message}\n`);
    return;
  }

  if (error instanceof ReviewError) {
    console.error(`\nReview failed [${error.code}]: ${error.message}`);
    if (error.code === ErrorCodes.RETRY_EXHAUSTED && error.details instanceof ReviewError) {
      console.error(`Cause [${error.details.code}]: ${error.details.message}`);
      const causeHint = HINTS[error.details.code];
      if (causeHint) console.error(`Hint: ${causeHint}`);
    }
    const hint = HINTS[error.code];
    if (hint) console.error(`Hint: ${hint}`);
  } else {
    const message = errorMessage(error);
    console.error(`\nUnexpected error: ${message}`);
    if (/api key|authentication|401|403/i.test(message)) {
      console.error('Hint: check ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL (or your AWS credentials).');
    } else if (/ENOENT|spawn/i.test(message)) {
      console.error('Hint: make sure Node.js and npx are on your PATH and dependencies are installed (npm install).');
    }
  }

  if (process.env.LOG_LEVEL === 'debug' && error instanceof Error && error.stack) {
    console.error(`\n${error.stack}`);
  } else {
    console.error('(Set LOG_LEVEL=debug for the full stack trace.)\n');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const authMethod = validateAuthentication();
  const model = validateModel(authMethod);
  const projectRoot = validateProjectRoot();
  checkGitHubToken();

  const label = `${args.owner}/${args.repo}#${args.prNumber}`;
  logger.info(`Reviewing ${label} with ${model}. This usually takes a few minutes...`);
  const startedAt = Date.now();

  const orchestrator = new Orchestrator({ model, projectRoot });
  const report = await orchestrator.reviewPullRequest(args.owner, args.repo, args.prNumber);
  const files = await saveReports(report, args, projectRoot);

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
  logger.info(`Review of ${label} completed in ${seconds}s`);
  console.log('\nReports saved:');
  for (const file of files) console.log(`  ${path.relative(process.cwd(), file) || file}`);
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    printFriendlyError(error);
    process.exit(1);
  });
