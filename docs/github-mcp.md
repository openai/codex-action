# Using the GitHub MCP server

`codex-action` can use MCP servers configured in the selected Codex home. For GitHub automation, the simplest setup is GitHub's remote MCP server together with a GitHub token exposed only to the Codex step.

The OpenAI API key and the GitHub token serve different purposes:

- `openai-api-key` authenticates Codex model requests through the action's Responses proxy.
- `GITHUB_TOKEN` authenticates the GitHub MCP server.

## Example

The workflow below gives the MCP server read access to repository contents and write access to pull requests. Narrow the `permissions` block further when the task does not need to write to GitHub.

```yaml
name: Codex review with GitHub MCP

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - name: Configure GitHub MCP
        shell: bash
        env:
          CODEX_HOME: ${{ runner.temp }}/codex-home
        run: |
          mkdir -p "$CODEX_HOME"
          cat > "$CODEX_HOME/config.toml" <<'EOF'
          [mcp_servers.github]
          url = "https://api.githubcopilot.com/mcp/"
          bearer_token_env_var = "GITHUB_TOKEN"
          required = true
          EOF

      - name: Run Codex
        uses: openai/codex-action@v1
        env:
          GITHUB_TOKEN: ${{ github.token }}
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          codex-home: ${{ runner.temp }}/codex-home
          prompt: |
            Review this pull request. Use the GitHub MCP tools when you need
            repository or pull-request context.
```

The action preserves the caller's existing `config.toml` when it adds its own Responses proxy configuration, so the MCP server entry remains available to `codex exec`.

## Using a separate GitHub token

If the job needs permissions that you do not want to grant to the workflow's generated token, store a dedicated token as a GitHub secret and expose it under the environment variable named by `bearer_token_env_var`:

```yaml
env:
  GITHUB_TOKEN: ${{ secrets.CODEX_GITHUB_TOKEN }}
```

Grant that token only the repository permissions required by the MCP tools you intend Codex to use.

## Local GitHub MCP server

GitHub also publishes a local MCP server that can run through Docker or as a binary. To use that form, configure a normal Codex stdio MCP server in `config.toml` with `command`, `args`, and any required environment variables. The remote configuration above avoids installing or managing another long-lived process in the Actions job.

## Troubleshooting

- If Codex can see the MCP server but GitHub writes fail, check the workflow `permissions` block or the permissions on the token supplied as `GITHUB_TOKEN`.
- If the MCP server fails to initialize, keep `required = true` while debugging so `codex exec` fails instead of silently continuing without GitHub tools.
- If you use a custom `codex-home`, create its `config.toml` before invoking `codex-action` and pass the same path through the `codex-home` input.

See GitHub's `github/github-mcp-server` repository for the remote server's authentication and toolset options, and the Codex configuration reference for additional MCP settings such as tool allow-lists and timeouts.
