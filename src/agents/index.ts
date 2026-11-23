import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { codeQualityAnalyzer } from './code-quality-analyzer.js';
import {
  CODE_QUALITY_ANALYZER,
  REFACTORING_SUGGESTER,
  TEST_COVERAGE_ANALYZER,
  type SubagentName,
} from './names.js';
import { refactoringSuggester } from './refactoring-suggester.js';
import { testCoverageAnalyzer } from './test-coverage-analyzer.js';

export { codeQualityAnalyzer } from './code-quality-analyzer.js';
export { testCoverageAnalyzer } from './test-coverage-analyzer.js';
export { refactoringSuggester } from './refactoring-suggester.js';
export * from './names.js';

/** All subagents keyed by name: passed directly to query({ options: { agents } }). */
export const subagents: Record<SubagentName, AgentDefinition> = {
  [CODE_QUALITY_ANALYZER]: codeQualityAnalyzer,
  [TEST_COVERAGE_ANALYZER]: testCoverageAnalyzer,
  [REFACTORING_SUGGESTER]: refactoringSuggester,
};
