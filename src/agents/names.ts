/**
 * Subagent names. They are the keys in the query() `agents` option and the names the
 * orchestrator prompt uses for explicit invocation, so they must stay in sync.
 */
export const CODE_QUALITY_ANALYZER = 'code-quality-analyzer';
export const TEST_COVERAGE_ANALYZER = 'test-coverage-analyzer';
export const REFACTORING_SUGGESTER = 'refactoring-suggester';

export const SUBAGENT_NAMES = [
  CODE_QUALITY_ANALYZER,
  TEST_COVERAGE_ANALYZER,
  REFACTORING_SUGGESTER,
] as const;

export type SubagentName = (typeof SUBAGENT_NAMES)[number];
