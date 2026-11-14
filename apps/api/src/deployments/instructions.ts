import type { DeployInstruction, Impact } from '@mcp-builder/shared';

interface ToolInfo { name: string; description: string; impact: Impact; requireConfirm: boolean }

/** Copyable client snippets for a deployed MCP server. `{{TOKEN}}` is substituted by the UI when the token is known. */
export function buildInstructions(p: { url: string; slug: string; projectName: string; description: string; tools: ToolInfo[] }): DeployInstruction[] {
  const envVar = `${p.slug.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_TOKEN`;
  const tomlKey = p.slug.replace(/[^a-zA-Z0-9_]/g, '_');
  const toolLines = p.tools.map((t) => `- \`${t.name}\` (${t.impact}${t.requireConfirm ? ', ask the user first' : ''}): ${t.description.split('\n')[0]}`);
  return [
    {
      id: 'claude-code',
      title: 'Claude Code',
      language: 'bash',
      content: `claude mcp add --transport http ${p.slug} ${p.url} \\\n  --header "Authorization: Bearer {{TOKEN}}"`,
    },
    {
      id: 'codex',
      title: 'Codex CLI',
      language: 'toml',
      content: `# ~/.codex/config.toml  (then: export ${envVar}="{{TOKEN}}")\n[mcp_servers.${tomlKey}]\nurl = "${p.url}"\nbearer_token_env_var = "${envVar}"`,
    },
    {
      id: 'json',
      title: 'MCP client JSON',
      language: 'json',
      content: JSON.stringify({ mcpServers: { [p.slug]: { type: 'http', url: p.url, headers: { Authorization: 'Bearer {{TOKEN}}' } } } }, null, 2),
    },
    {
      id: 'curl',
      title: 'Test with curl',
      language: 'bash',
      content: `curl -s ${p.url} \\\n  -H "Authorization: Bearer {{TOKEN}}" \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    },
    {
      id: 'agent-prompt',
      title: 'Agent instructions',
      language: 'markdown',
      content: `You can use the "${p.slug}" MCP server (${p.projectName}). ${p.description}\n\nTools:\n${toolLines.join('\n')}\n\nOnly use these tools for data you need; never guess values a tool can look up. For tools marked "ask the user first", confirm with the user before calling them.`,
    },
  ];
}
