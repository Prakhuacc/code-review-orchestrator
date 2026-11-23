import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { GITHUB_MCP_TOOLS } from '../config/mcp.config.js';
import { TEST_COVERAGE_ANALYZER_PROMPT } from '../prompts/test-coverage-analyzer.prompt.js';

/**
 * Test Coverage Analyzer: compares changed source files with their tests to find untested
 * functions/branches, estimate coverage and propose concrete test cases.
 * search_code is included to locate test files; everything is read-only.
 */
export const testCoverageAnalyzer: AgentDefinition = {
  description:
    'Test coverage specialist for pull request reviews. Use this agent to identify functions, methods and ' +
    'branches added or changed by a PR that have no tests, estimate the coverage percentage, judge assertion ' +
    'quality and suggest specific test cases with concrete assertions, prioritizing critical untested paths. ' +
    'Returns TestCoverageResult JSON.',
  prompt: TEST_COVERAGE_ANALYZER_PROMPT,
  tools: [
    'Read',
    'Grep',
    'Glob',
    'Skill',
    GITHUB_MCP_TOOLS.getFileContents,
    GITHUB_MCP_TOOLS.getPullRequestFiles,
    GITHUB_MCP_TOOLS.searchCode,
  ],
  model: 'inherit',
};
