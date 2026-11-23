import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { GITHUB_MCP_TOOLS } from '../config/mcp.config.js';
import { REFACTORING_SUGGESTER_PROMPT } from '../prompts/refactoring-suggester.prompt.js';

/**
 * Refactoring Suggester: structural improvements (extract method/class, design patterns,
 * modern language features, dead code) with before/after examples. Read-only tools only.
 */
export const refactoringSuggester: AgentDefinition = {
  description:
    'Refactoring and architecture specialist for pull request reviews. Use this agent to identify ' +
    'extract-method and extract-class candidates, design-pattern opportunities, modern language features to ' +
    'adopt, and dead or redundant code in the changed files. Every suggestion includes before/after code. ' +
    'Returns RefactoringSuggestion JSON.',
  prompt: REFACTORING_SUGGESTER_PROMPT,
  tools: ['Read', 'Grep', 'Glob', 'Skill', GITHUB_MCP_TOOLS.getFileContents],
  model: 'inherit',
};
