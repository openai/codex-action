# Codex GitHub Action

Run [Codex](https://github.com/openai/codex#codex-exec) from a GitHub Actions workflow while keeping tight control over the privileges available to Codex. This action handles installing the Codex CLI and configuring it with a secure proxy to the [Responses API](https://platform.openai.com/docs/api-reference/responses).

Users must provide an API key for their chosen provider (for example, [`OPENAI_API_KEY`](https://platform.openai.com/api-keys) or `AZURE_OPENAI_API_KEY` [if using Azure for OpenAI models](#azure)) as a [GitHub Actions secret](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets) to use this action.

## Example: Create Your Own Pull Request Bot

While Codex cloud offers a [powerful code review tool](https://developers.openai.com/codex/cloud/code-review) that you can use today, here is an example of how you can build your own code review workflow with `openai/codex-action` if you want to have more control over the experience.

In the following example, we define a workflow that is triggered whenever a user creates a pull request that:

- Creates a shallow clone of the repo.
- Ensures the `base` and `head` refs for the PR are available locally.
- Runs Codex with a `prompt` that includes the details specific to the PR.
- Takes the output from Codex and posts it as a comment on the PR.

See [`security.md`](./docs/security.md) for tips on using `openai/codex-action` securely and the
[Codex permissions documentation](https://developers.openai.com/codex/permissions) for configuring
filesystem and network access.

```yaml
name: Perform a code review when a pull request is created.
on:
  pull_request:
    types: [opened]

jobs:
  codex:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      final_message: ${{ steps.run_codex.outputs.final-message }}
    steps:
      - uses: actions/checkout@v5
        with:
          # Explicitly check out the PR's merge commit.
          ref: refs/pull/${{ github.event.pull_request.number }}/merge
          persist-credentials: false

      - name: Pre-fetch base and head refs for the PR
        env:
          PR_BASE_REF: ${{ github.event.pull_request.base.ref }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
        run: |
          # Pass GitHub expressions through env and quote shell expansions.
          git fetch --no-tags origin \
            "$PR_BASE_REF" \
            "+refs/pull/$PR_NUMBER/head"

      # If you want Codex to build and run code, install any dependencies that
      # need to be downloaded before the "Run Codex" step. The recommended
      # :workspace permission profile does not grant network access.

      - name: Run Codex
        id: run_codex
        uses: openai/codex-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          permission-profile: ":workspace"
          prompt: |
            This is PR #${{ github.event.pull_request.number }} for ${{ github.repository }}.

            Review ONLY the changes introduced by the PR, so consider:
               git log --oneline ${{ github.event.pull_request.base.sha }}...${{ github.event.pull_request.head.sha }}

            Suggest any improvements, potential bugs, or issues.
            Be concise and specific in your feedback.

            Pull request title and body:
            ----
            ${{ github.event.pull_request.title }}
            ${{ github.event.pull_request.body }}

  post_feedback:
    runs-on: ubuntu-latest
    needs: codex
    if: needs.codex.outputs.final_message != ''
    permissions:
      issues: write
      pull-requests: write
    steps:
      - name: Report Codex feedback
        uses: actions/github-script@v7
        env:
          CODEX_FINAL_MESSAGE: ${{ needs.codex.outputs.final_message }}
        with:
          github-token: ${{ github.token }}
          script: |
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.payload.pull_request.number,
              body: process.env.CODEX_FINAL_MESSAGE,
            });
```

## Inputs

| Name                     | Description                                                                                                                                    | Default     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `openai-api-key`         | Secret used to start the Responses API proxy when you are using OpenAI (default). Store it in `secrets`.                                       | `""`        |
| `responses-api-endpoint` | Optional Responses API endpoint override, e.g. `https://example.openai.azure.com/openai/v1/responses`. Leave empty to use the proxy's default. | `""`        |
| `prompt`                 | Inline prompt text. Provide this or `prompt-file`.                                                                                             | `""`        |
| `prompt-file`            | Path (relative to the repository root) of a file that contains the prompt. Provide this or `prompt`.                                           | `""`        |
| `output-file`            | File where the final Codex message is written. Leave empty to skip writing a file.                                                             | `""`        |
| `working-directory`      | Directory passed to `codex exec --cd`. Defaults to the repository root.                                                                        | `""`        |
| `sandbox`                | Legacy sandbox mode. Prefer `permission-profile: ":workspace"` for new workflows. Mutually exclusive with `permission-profile`.               | `""`        |
| `permission-profile`     | Built-in or configured [Codex permission profile](https://developers.openai.com/codex/permissions) selected through `default_permissions`.      | `""`        |
| `codex-version`          | Version of `@openai/codex` to install.                                                                                                         | `""`        |
| `codex-args`             | Extra arguments forwarded to `codex exec`. Accepts JSON arrays (`["--flag", "value"]`) or shell-style strings.                                 | `""`        |
| `output-schema`          | Inline schema contents written to a temp file and passed to `codex exec --output-schema`. Mutually exclusive with `output-schema-file`.        | `""`        |
| `output-schema-file`     | Schema file forwarded to `codex exec --output-schema`. Leave empty to skip passing the option.                                                 | `""`        |
| `model`                  | Model the agent should use. Leave empty to let Codex pick its default.                                                                         | `""`        |
| `effort`                 | Reasoning effort the agent should use. Leave empty to let Codex pick its default.                                                              | `""`        |
| `codex-home`             | Directory to use as the Codex CLI home (config/cache). Uses the CLI default when empty.                                                        | `""`        |
| `safety-strategy`        | Controls how the action restricts Codex privileges. See [Safety strategy](#safety-strategy).                                                   | `drop-sudo` |
| `codex-user`             | Username to run Codex as when `safety-strategy` is `unprivileged-user`.                                                                        | `""`        |
| `allow-users`            | List of GitHub usernames who can trigger the action in addition to those who have write access to the repo.                                    | `""`        |
| `allow-bots`             | Allow runs triggered by trusted GitHub bot accounts (`github-actions[bot]`) to bypass the write-access check.                                  | `false`     |
| `allow-bot-users`        | List of GitHub bot usernames that can bypass the write-access check. `*` is not supported; list trusted bots explicitly.                       | `""`        |

## Permission profiles

Codex permission profiles independently describe filesystem and network access. For workflows that
need to edit the checked-out repository, prefer `permission-profile: ":workspace"` over relying on
the action's legacy `workspace-write` fallback. Use `:read-only` for read-only workflows, or select a
named profile defined in the `config.toml` under `codex-home` when the workflow needs a more specific
policy. See the
[Codex permissions documentation](https://developers.openai.com/codex/permissions) for the profile
schema and enforcement details. Permission profiles are beta and require Codex CLI `0.138.0` or
later; do not select one while pinning an older `codex-version`.

The action does not pass `--sandbox` when `permission-profile` is set because the profile and legacy
sandbox systems do not compose. Supplying both inputs fails before Codex starts. The
`safety-strategy: read-only` option also forces the legacy read-only sandbox and therefore cannot be
combined with a permission profile. Keep `safety-strategy: drop-sudo` or use a deliberately
configured unprivileged user when selecting a profile.

For backward compatibility, omitting both `permission-profile` and `sandbox` still runs Codex with
the legacy `workspace-write` sandbox. Existing callers that set `sandbox` continue to use the legacy
model. Existing `codex-args` such as `--search`, `--ephemeral`, `--model`, benign `-c` overrides
(including `model_reasoning_effort` and `service_tier`), and `--enable use_legacy_landlock` remain
supported. Protected runs reject overrides that change permissions, trust, model providers, or
command execution; alternate configuration profiles; additional writable directories; and conflicting
hook or sandbox bypasses. `--full-auto` cannot be combined with a permission profile or an effective
read-only sandbox. Image attachments and overrides loading local instruction, compaction, or catalog
files remain supported except with custom named permission profiles, where unsandboxed reads could
bypass scoped filesystem access. Explicitly unsafe, unrestricted runs retain argument pass-through.

Treat `codex-home/config.toml` and named profile definitions as trusted workflow configuration.
They are not sanitized by `codex-args` validation and must not come from an untrusted checkout.

For example, use the built-in `:workspace` profile for a workflow that needs to modify the checkout:

```yaml
- name: Run Codex with a permission profile
  uses: openai/codex-action@v1
  with:
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    permission-profile: ":workspace"
    prompt: Review the public change.
```

## Safety Strategy

The `safety-strategy` input determines how much access Codex receives on the runner. Choosing the right option is critical, especially when sensitive secrets (like your OpenAI API key) are present.

See [Protecting your `OPENAI_API_KEY`](./docs/security.md#protecting-your-openai_api_key) on the Security page for important details on this topic.

- **`drop-sudo` (default)** — On Linux and macOS runners, the action revokes the default user’s `sudo` access before invoking Codex. On Linux, it also removes access to existing root-owned service sockets under `/run` that the runner can write, including the Docker daemon. Codex starts with `no_new_privs`, no supplementary groups, and empty bounding, permitted, effective, inheritable, and ambient capability sets in the host user namespace. Descendants inherit `no_new_privs`; they can gain capabilities inside a new user namespace, but those do not grant host privileges. The account and socket mutations can outlive a job on reused self-hosted runners; use this strategy on disposable runners and run the action as the last step in a job.
- **`unprivileged-user`** — Runs Codex as the user provided via `codex-user`. Use this if you manage your own runner with a pre-created unprivileged account. Ensure the user can read the repository checkout and any files Codex needs. See [`unprivileged-user.yml`](./examples/unprivileged-user.yml) for an example of how to configure such an account on `ubuntu-latest`.
- **`read-only`** — Executes Codex in a read-only sandbox. Codex can view files but cannot mutate the filesystem or access the network directly. The OpenAI API key still flows through the proxy, so Codex could read it if it can reach process memory.
- **`unsafe`** — No privilege reduction. Codex runs as the default `runner` user (which typically has `sudo`). Only use this when you fully trust the prompt. On Windows runners this is the only supported choice and the action will fail if another option is provided.

### Operating system support

- **Windows**: GitHub-hosted Windows runners lack a supported sandbox. Set `safety-strategy: unsafe`. The action validates this and exits early otherwise.
- **Linux/macOS**: All options for `safety-strategy` are supported. Linux `drop-sudo` requires passwordless `sudo` and `/usr/bin/setpriv` before Codex starts. Any mode that uses bubblewrap, including the default `workspace-write` sandbox and built-in `:workspace`/`:read-only` profiles, also requires working unprivileged user namespaces; setuid-only bubblewrap installations are unsupported because `no_new_privs` is enforced for every Linux `drop-sudo` Codex launch. Sandbox-backend startup errors occur after the irreversible account and socket cleanup, so validate self-hosted runner configurations on disposable hosts. Running the action again with a prompt after `sudo` has already been removed fails instead of running without these protections. Run subsequent work requiring elevated privileges in a fresh `job` on a new host.
- **GitHub-hosted Linux runners**: The action enables unprivileged user namespaces during setup and clears Ubuntu's AppArmor gate when present. This avoids the `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` failure seen on newer hosted images. Self-hosted Linux runners must enable unprivileged user namespaces, allow a sufficient `user.max_user_namespaces`, and configure AppArmor or SELinux to permit them before using bubblewrap-backed `drop-sudo` modes.

## Outputs

| Name            | Description                             |
| --------------- | --------------------------------------- |
| `final-message` | Final message returned by `codex exec`. |

As we saw in the example above, we took the `final-message` output of the `run_codex` step and made it an output of the `codex` job in the workflow:

```yaml
jobs:
  codex:
    # ...
    outputs:
      final_message: ${{ steps.run_codex.outputs.final-message }}
```

## Additional tips

- Run this action after `actions/checkout@v5` so Codex has access to your repository contents.
- To use a non-default Responses endpoint (for example Azure OpenAI), set `responses-api-endpoint` to the provider's URL while keeping `openai-api-key` populated; the proxy will still send `Authorization: Bearer <key>` upstream.
- If you want Codex to have access to a narrow set of privileged functionality, consider running a local MCP server that can perform these actions and configure Codex to use it.
- If you need more control over the CLI invocation, pass supported flags through `codex-args` or create a trusted `config.toml` in `codex-home`. Prefer a [permission profile](https://developers.openai.com/codex/permissions), starting with `:workspace` for workspace editing, over legacy sandbox flags for new integrations.
- Calling `codex` directly from later scripts does not receive the action's `no_new_privs`, capability, or supplementary-group protections. Provide `prompt` or `prompt-file` to run Codex through the action; on Linux, use a new job if `drop-sudo` has already been applied.

## GitHub MCP in Actions

Codex can use MCP servers configured in the `config.toml` under `codex-home`. To give Codex
access to GitHub tools from a workflow, create a temporary Codex home, write the official hosted
GitHub MCP server configuration, and pass the token environment variable referenced by the config.

```yaml
name: Review with Codex and GitHub MCP
on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  codex:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v5
        with:
          persist-credentials: false

      - name: Configure GitHub MCP
        run: |
          mkdir -p "${{ runner.temp }}/codex-home"
          cat > "${{ runner.temp }}/codex-home/config.toml" <<'EOF'
          [mcp_servers.github]
          url = "https://api.githubcopilot.com/mcp/"
          bearer_token_env_var = "GITHUB_MCP_TOKEN"
          EOF

      - name: Run Codex with GitHub MCP
        uses: openai/codex-action@v1
        env:
          GITHUB_MCP_TOKEN: ${{ secrets.GITHUB_MCP_TOKEN }}
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          codex-home: ${{ runner.temp }}/codex-home
          permission-profile: ":workspace"
          prompt: |
            This is PR #${{ github.event.pull_request.number }} in ${{ github.repository }}.
            Use the GitHub MCP tools to inspect the pull request and add a concise
            review comment with any actionable findings.
```

Use a least-privilege token for `GITHUB_MCP_TOKEN`; for example, grant only the repository
permissions required by the tools you expect Codex to call. The workflow's `github.token` remains
read-only in this example, and checkout does not persist it into Git configuration, so Codex uses
the explicit MCP token for GitHub write operations. See the [GitHub MCP Server Codex installation
guide](https://github.com/github/github-mcp-server/blob/main/docs/installation-guides/install-codex.md)
for current GitHub MCP server options and token guidance.

## Azure

To configure the Action to use OpenAI models hosted on Azure, pay close attention to the following:

- The `responses-api-endpoint` must be set to the full URL (including any required query parameters) that Codex will `POST` to for a Responses API request. For Azure, this might look like `https://YOUR_PROJECT_NAME.openai.azure.com/openai/v1/responses`. Note that [unlike when customizing a model provider in Codex](https://github.com/openai/codex/blob/main/docs/config.md#azure-model-provider-example), you must include the `v1/responses` suffix to the URL yourself, if appropriate.
- The `openai-api-key` input must be a valid key that can be used with the `Authorization: Bearer <KEY>` header when making a `POST` request to your Responses API endpoint. (This is also true for the value of the [`env_key`](https://github.com/openai/codex/blob/main/docs/config.md#azure-model-provider-example) when setting a custom provider using the Codex CLI.)

Ultimately, your configured Action might look something like the following:

```yaml
- name: Start Codex proxy
  uses: openai/codex-action@v1
  with:
    openai-api-key: ${{ secrets.AZURE_OPENAI_API_KEY }}
    responses-api-endpoint: "https://bolinfest-7804-resource.cognitiveservices.azure.com/openai/v1/responses"
    prompt: "Debug all the things."
```

## Version History

See the [`CHANGELOG`](./CHANGELOG.md) for details.

## License

This project is licensed under the [Apache License 2.0](./LICENSE).
