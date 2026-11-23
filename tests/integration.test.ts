/**
 * End-to-end integration test against a real public pull request (octocat/Hello-World#1).
 * It calls the real Claude API and GitHub, so it only runs when explicitly enabled:
 *
 *   RUN_INTEGRATION=1 npm test -- tests/integration.test.ts
 *
 * The same path is exercised manually by: npm run dev -- octocat Hello-World 1
 */
import 'dotenv/config';
import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/orchestrator.js';
import { ReviewReportSchema } from '../src/types/index.js';

const enabled = process.env.RUN_INTEGRATION === '1';
const TWENTY_FIVE_MINUTES = 25 * 60_000;

describe.skipIf(!enabled)('integration: octocat/Hello-World#1', () => {
  it(
    'fetches the PR via GitHub MCP, runs all subagents and returns a schema-valid ReviewReport',
    async () => {
      const orchestrator = new Orchestrator({ maxRetries: 1 });
      const report = await orchestrator.reviewPullRequest('octocat', 'Hello-World', 1);

      const validation = ReviewReportSchema.safeParse(report);
      expect(validation.success).toBe(true);
      expect(JSON.stringify(report).length).toBeGreaterThan(200);
    },
    TWENTY_FIVE_MINUTES,
  );
});
