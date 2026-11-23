import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { ESLINT_MCP_TOOLS, GITHUB_MCP_TOOLS } from '../config/mcp.config.js';
import { CODE_QUALITY_ANALYZER_PROMPT } from '../prompts/code-quality-analyzer.prompt.js';

/**
 * Code Quality Analyzer: security, performance and best-practice review of the changed files.
 * Read-only tools only (least privilege). The Skill tool lets it load the
 * security-analysis, javascript-best-practices and code-review-best-practices skills.
 */
export const codeQualityAnalyzer: AgentDefinition = {
  description:
    'Code quality specialist for pull request reviews. Use this agent to find security vulnerabilities ' +
    '(injection, XSS, hard-coded secrets, missing authorization), performance problems and best-practice or ' +
    'maintainability violations in the changed files of a PR. Returns findings with file path, line number, ' +
    'severity and a concrete fix as CodeQualityResult JSON.',
  prompt: CODE_QUALITY_ANALYZER_PROMPT,
  tools: [
    'Read',
    'Grep',
    'Glob',
    'Skill',
    GITHUB_MCP_TOOLS.getFileContents,
    GITHUB_MCP_TOOLS.getPullRequestFiles,
    ESLINT_MCP_TOOLS.lintFiles,
  ],
  model: 'inherit',
};
