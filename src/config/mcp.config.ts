/**
 * MCP (Model Context Protocol) server configuration.
 *
 * Two stdio servers are launched on demand through npx (no global install needed):
 *  - github: pull request metadata, changed files + patches, file contents
 *            (@modelcontextprotocol/server-github)
 *  - eslint: linting through the official ESLint MCP server (@eslint/mcp)
 *
 * Secrets are never hard-coded. The GitHub token is read from process.env when the
 * config is built (after dotenv has loaded .env) and mapped to the variable name the
 * GitHub server expects.
 */
import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';

export const MCP_SERVER_NAMES = {
  github: 'github',
  eslint: 'eslint',
} as const;

export type McpServerName = (typeof MCP_SERVER_NAMES)[keyof typeof MCP_SERVER_NAMES];

/** Fully-qualified tool name the Agent SDK exposes for an MCP tool: mcp__<server>__<tool>. */
export function mcpToolName(server: McpServerName, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** GitHub MCP server: stdio transport, run with npx, authenticated with GITHUB_TOKEN. */
export function getGitHubMcpConfig(): McpStdioServerConfig {
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: {
      // The server reads GITHUB_PERSONAL_ACCESS_TOKEN; our .env uses the shorter GITHUB_TOKEN.
      GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN ?? '',
    },
  };
}

/** ESLint MCP server: stdio transport, run with npx. It needs no authentication. */
export function getEslintMcpConfig(): McpStdioServerConfig {
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@eslint/mcp@latest'],
  };
}

/** Both servers, keyed by the names used in tool identifiers (mcp__github__..., mcp__eslint__...). */
export function getMcpServers(): Record<McpServerName, McpStdioServerConfig> {
  return {
    [MCP_SERVER_NAMES.github]: getGitHubMcpConfig(),
    [MCP_SERVER_NAMES.eslint]: getEslintMcpConfig(),
  };
}

/**
 * Read-only GitHub tools used by the orchestrator and subagents.
 * Least privilege: no create/update/merge/push tools are allowed.
 */
export const GITHUB_MCP_TOOLS = {
  getPullRequest: mcpToolName(MCP_SERVER_NAMES.github, 'get_pull_request'),
  getPullRequestFiles: mcpToolName(MCP_SERVER_NAMES.github, 'get_pull_request_files'),
  getPullRequestStatus: mcpToolName(MCP_SERVER_NAMES.github, 'get_pull_request_status'),
  getPullRequestComments: mcpToolName(MCP_SERVER_NAMES.github, 'get_pull_request_comments'),
  getPullRequestReviews: mcpToolName(MCP_SERVER_NAMES.github, 'get_pull_request_reviews'),
  getFileContents: mcpToolName(MCP_SERVER_NAMES.github, 'get_file_contents'),
  listCommits: mcpToolName(MCP_SERVER_NAMES.github, 'list_commits'),
  searchCode: mcpToolName(MCP_SERVER_NAMES.github, 'search_code'),
} as const;

export const ESLINT_MCP_TOOLS = {
  lintFiles: mcpToolName(MCP_SERVER_NAMES.eslint, 'lint-files'),
} as const;

/** Every MCP tool the system may use, derived from the server configuration above. */
export const ALL_MCP_TOOLS: string[] = [
  ...Object.values(GITHUB_MCP_TOOLS),
  ...Object.values(ESLINT_MCP_TOOLS),
];
