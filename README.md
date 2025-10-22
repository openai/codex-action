# Codex GitHub Action

Run [Codex](https://github.com/openai/codex#codex-exec) from a GitHub Actions workflow while keeping tight control over the privileges available to Codex. This action handles installing the Codex CLI and configuring it with a secure proxy to the [Responses API](https://platform.openai.com/docs/api-reference/responses).

Users must provide their [`OPENAI_API_KEY`](https://platform.openai.com/api-keys) as a [GitHub Actions secret](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets) to use this action.

## Example: Create Your Own Pull Request Bot

While Codex cloud offers a [powerful code review tool](https://developers.openai.com/codex/cloud/code-review) that you can use today, here is an example of how you can build your own code review workflow with `openai/codex-action` if you want to have more control over the experience.

In the following example, we define a workflow that is triggered whenever a user creates a pull request that:

- Creates a shallow clone of the repo.
- Ensures the `base` and `head` refs for the PR are available locally.
- Runs Codex with a `prompt` that includes the details specific to the PR.
- Takes the output from Codex and posts it as a comment on the PR.

See [`security.md`](./docs/security.md) for tips on using `openai/codex-action` securely.

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

      - name: Pre-fetch base and head refs for the PR
        run: |
          git fetch --no-tags origin \
            ${{ github.event.pull_request.base.ref }} \
            +refs/pull/${{ github.event.pull_request.number }}/head

      # If you want Codex to build and run code, install any dependencies that
      # need to be downloaded before the "Run Codex" step because Codex's
      # default sandbox disables network access.

      - name: Run Codex
        id: run_codex
        uses: openai/codex-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          prompt: |
            This is PR #${{ github.event.pull_request.number }} for ${{ github.repository }}.
            Base SHA: ${{ github.event.pull_request.base.sha }}
            Head SHA: ${{ github.event.pull_request.head.sha }}

            Review ONLY the changes introduced by the PR.
            Use merge-base comparison (three-dot) to see the PR changes.
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

| Name                 | Description                                                                                                                             | Default     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `openai-api-key`     | Secret used to start the Responses API proxy. Required when starting the proxy (key-only or key+prompt). Store it in `secrets`.         | `""`        |
| `prompt`             | Inline prompt text. Provide this or `prompt-file`.                                                                                      | `""`        |
| `prompt-file`        | Path (relative to the repository root) of a file that contains the prompt. Provide this or `prompt`.                                    | `""`        |
| `output-file`        | File where the final Codex message is written. Leave empty to skip writing a file.                                                      | `""`        |
| `working-directory`  | Directory passed to `codex exec --cd`. Defaults to the repository root.                                                                 | `""`        |
| `sandbox`            | Sandbox mode for Codex. One of `workspace-write` (default), `read-only` or `danger-full-access`.                                        | `""`        |
| `codex-version`      | Version of `@openai/codex` to install.                                                                                                  | `""`        |
| `codex-args`         | Extra arguments forwarded to `codex exec`. Accepts JSON arrays (`["--flag", "value"]`) or shell-style strings.                          | `""`        |
| `output-schema`      | Inline schema contents written to a temp file and passed to `codex exec --output-schema`. Mutually exclusive with `output-schema-file`. | `""`        |
| `output-schema-file` | Schema file forwarded to `codex exec --output-schema`. Leave empty to skip passing the option.                                          | `""`        |
| `model`              | Model the agent should use. Leave empty to let Codex pick its default.                                                                  | `""`        |
| `codex-home`         | Directory to use as the Codex CLI home (config/cache). Uses the CLI default when empty.                                                 | `""`        |
| `safety-strategy`    | Controls how the action restricts Codex privileges. See [Safety strategy](#safety-strategy).                                            | `drop-sudo` |
| `codex-user`         | Username to run Codex as when `safety-strategy` is `unprivileged-user`.                                                                 | `""`        |
| `allow-users`        | List of GitHub usernames who can trigger the action in addition to those who have write access to the repo.                             | ""          |
| `allow-bots`         | Allow runs triggered by GitHub Apps/bot accounts to bypass the write-access check.                                                      | "false"     |

## Safety Strategy

The `safety-strategy` input determines how much access Codex receives on the runner. Choosing the right option is critical, especially when sensitive secrets (like your OpenAI API key) are present.

See [Protecting your `OPENAI_API_KEY`](./docs/security.md#protecting-your-openai_api_key) on the Security page for important details on this topic.

- **`drop-sudo` (default)** — On Linux and macOS runners, the action revokes the default user’s `sudo` membership before invoking Codex. Codex then runs as that user without superuser privileges. This change lasts for the rest of the job, so subsequent steps cannot rely on `sudo`. This is usually the safest choice on GitHub-hosted runners.
- **`unprivileged-user`** — Runs Codex as the user provided via `codex-user`. Use this if you manage your own runner with a pre-created unprivileged account. Ensure the user can read the repository checkout and any files Codex needs. See [`unprivileged-user.yml`](./examples/unprivileged-user.yml) for an example of how to configure such an account on `ubuntu-latest`.
- **`read-only`** — Executes Codex in a read-only sandbox. Codex can view files but cannot mutate the filesystem or access the network directly. The OpenAI API key still flows through the proxy, so Codex could read it if it can reach process memory.
- **`unsafe`** — No privilege reduction. Codex runs as the default `runner` user (which typically has `sudo`). Only use this when you fully trust the prompt. On Windows runners this is the only supported choice and the action will fail if another option is provided.

### Operating system support

- **Windows**: GitHub-hosted Windows runners lack a supported sandbox. Set `safety-strategy: unsafe`. The action validates this and exits early otherwise.
- **Linux/macOS**: All options for `safety-strategy` are supported. Again, if you pick `drop-sudo`, remember that later steps in your `job` that rely on `sudo` will fail. If you do need to run code that requires `sudo` after `openai/codex-action` has run, one option is to pipe the output of `openai/codex-action` to a fresh `job` on a new host and to continue your workflow from there.

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
- If you want Codex to have access to a narrow set of privileged functionality, consider running a local MCP server that can perform these actions and configure Codex to use it.
- If you need more control over the CLI invocation, pass flags through `codex-args` or create a `config.toml` in `codex-home`.
- Once `openai/codex-action` is run once with `openai-api-key`, you can also call `codex` from subsequent scripts in your job. (You can omit `prompt` and `prompt-file` from the action in this case.)

## License

This project is licensed under the [Apache License 2.0](./LICENSE).
