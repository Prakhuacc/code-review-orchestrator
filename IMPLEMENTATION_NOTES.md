# Implementation notes

## Install
Copy everything in this folder over `project/starter/` (it only adds/replaces the files you implement; `src/types`, `logger.ts`, `report-generator.ts`, `package.json`, `tsconfig.json` and the existing skill are untouched).

```bash
cd /voc/work && npm install
cd /voc/work/project/starter
npm ls zod-to-json-schema || npm install zod-to-json-schema   # only if missing
```

`.env` needs `ANTHROPIC_MODEL`, `PROJECT_ROOT` and (strongly recommended) `GITHUB_TOKEN`.

## Run order
```bash
npm run build                                  # TypeScript compiles
npm test                                       # schema + utility tests
npm run dev -- octocat Hello-World 1           # integration smoke test
bash scripts/review-all-prs.sh                 # generates the 9 required reports (~3-10 min per PR)
CHECK_DELIVERABLES=1 npm test                  # verifies all 9 files exist and every JSON matches ReviewReportSchema
```
Optional automated integration test: `RUN_INTEGRATION=1 npm test -- tests/integration.test.ts`.

Make sure `reports/` is not in `.gitignore` before you submit.

## Troubleshooting
- **GitHub MCP server failed to start** → set `GITHUB_TOKEN` in `.env`.
- **Error mentioning root/sudo and permissions** → the workspace runs as root; add `IS_SANDBOX=1` to `.env`.
- **Timeout** → raise `REVIEW_TIMEOUT_MS` (default 20 minutes).
- **Schema validation failed** → re-run the PR; set `LOG_LEVEL=debug` to see each tool call.
- Logs show `-> Spawning subagent: ...` and `Skill invoked by subagent: ...` lines: use them as evidence that all three subagents ran and skills were used.

## Design decisions (useful for the reviewer)
- **One SDK session per PR.** The orchestrator fetches the PR once, then spawns the three subagents in parallel through the Task tool with the full PR context in each prompt (subagents can't see the parent conversation).
- **Prompts embed the real schemas.** Each prompt includes the JSON Schema generated from its Zod schema (`schemaForPrompt`), so field names and enums always match `src/types`.
- **Least privilege.** Subagents only get read-only tools; `Write`, `Edit` and `Bash` are disallowed for the whole session.
- **Failure handling in two layers.** Inside the session, a failed subagent is retried once and then reported as unavailable (the report is still produced). Outside, the whole review is rate limited, timed out (aborting the SDK process) and retried with exponential backoff; configuration and MCP connection errors fail fast without retries.
- **Schema tests are generated from the schemas** (`tests/helpers/zod-fixtures.ts`): valid minimal/full objects, missing fields, wrong types, invalid enums, empty arrays and 0/100-style numeric boundaries for every field.
