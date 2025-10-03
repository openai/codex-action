# Codex Exec GitHub Action

Run [`codex exec`](https://github.com/openai/codex#codex-exec) directly from a GitHub Actions workflow while keeping tight control over the privileges available to Codex. This action handles installing the Codex CLI, starting the required proxy to the OpenAI Responses API, and cleaning up after execution so you can focus on the prompt you want to run.

## Quick Start

```yaml
name: Run Codex Exec
on:
  workflow_dispatch:
    inputs:
      prompt:
        description: Prompt to send to Codex
        required: true

jobs:
  codex:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - name: Run Codex
        uses: openai/codex-action@main
        id: codex
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          prompt: ${{ github.event.inputs.prompt }}
```

Provide either `prompt` or `prompt-file`; the other may be left empty. The action streams Codex output to the job logs and exposes the final message as an output named `final-message` for downstream steps.

## Inputs

| Name                 | Required      | Description                                                                                                                             | Default          |
| -------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `openai-api-key`     | Conditionally | Secret used to start the Responses API proxy. Required when starting the proxy (key-only or key+prompt). Store it in `secrets`.         | `""`             |
| `prompt`             | Conditionally | Inline prompt text. Provide this or `prompt-file`.                                                                                      | `""`             |
| `prompt-file`        | Conditionally | Path (relative to the repository root) of a file that contains the prompt. Provide this or `prompt`.                                    | `""`             |
| `output-file`        | No            | File where the final Codex message is written. Leave empty to skip writing a file.                                                      | `""`             |
| `working-directory`  | No            | Directory passed to `codex exec --cd`. Defaults to the repository root.                                                                 | `""`             |
| `sandbox`            | No            | Sandbox mode for Codex. One of `workspace-write` (default), `read-only` or `danger-full-access`.                                        | `""`             |
| `codex-version`      | No            | Version of `@openai/codex` to install.                                                                                                  | `0.42.0-alpha.3` |
| `codex-args`         | No            | Extra arguments forwarded to `codex exec`. Accepts JSON arrays (`["--flag", "value"]`) or shell-style strings.                          | `""`             |
| `output-schema`      | No            | Inline schema contents written to a temp file and passed to `codex exec --output-schema`. Mutually exclusive with `output-schema-file`. | `""`             |
| `output-schema-file` | No            | Schema file forwarded to `codex exec --output-schema`. Leave empty to skip passing the option.                                          | `""`             |
| `model`              | No            | Model the agent should use. Leave empty to let Codex pick its default.                                                                  | `""`             |
| `codex-home`         | No            | Directory to use as the Codex CLI home (config/cache). Uses the CLI default when empty.                                                 | `""`             |
| `safety-strategy`    | No            | Controls how the action restricts Codex privileges. See [Safety strategy](#safety-strategy).                                            | `drop-sudo`      |
| `codex-user`         | No            | Username to run Codex as when `safety-strategy` is `unprivileged-user`.                                                                 | `""`             |
| `require-repo-write` | No            | Whether to require the triggering actor to have write access to the repository before running.                                          | "true"           |
| `allow-bots`         | No            | Allow runs triggered by GitHub Apps/bot accounts to bypass the write-access check.                                                      | "false"          |

## Safety Strategy

- The `safety-strategy` input determines how much access Codex receives on the runner. Choosing the right option is critical, especially when sensitive secrets (like your OpenAI API key) are present.

- **`drop-sudo` (default)** — On Linux and macOS runners, the action revokes the default user’s `sudo` membership before invoking Codex. Codex then runs as that user without superuser privileges. This change lasts for the rest of the job, so subsequent steps cannot rely on `sudo`. This is usually the safest choice on GitHub-hosted runners.
- **`unprivileged-user`** — Runs Codex as the user provided via `codex-user`. Use this if you manage your own runner with a pre-created unprivileged account. Ensure the user can read the repository checkout and any files Codex needs.
- **`read-only`** — Executes Codex in a read-only sandbox. Codex can view files but cannot mutate the filesystem or access the network directly. The OpenAI API key still flows through the proxy, so Codex could read it if it can reach process memory.
- **`unsafe`** — No privilege reduction. Codex runs as the default `runner` user (which typically has `sudo`). Only use this when you fully trust the prompt. On Windows runners this is the only supported choice and the action will fail if another option is provided.

### Operating system support

- **Windows**: GitHub-hosted Windows runners lack a supported sandbox. Set `safety-strategy: unsafe`. The action validates this and exits early otherwise.
- **Linux/macOS**: All options for `safety-strategy` are supported. Again, if you pick `drop-sudo`, remember that later steps in your `job` that rely on `sudo` will fail. If you do need to run code that requires `sudo` after `openai/codex-action` has run, one option is to pipe the output of `openai/codex-action` to a fresh `job` on a new host and to continue your workflow from there.

## Outputs

| Name            | Description                             |
| --------------- | --------------------------------------- |
| `final-message` | Final message returned by `codex exec`. |

You can reference the output from later steps:

```yaml
# steps.codex refers to the `id: codex` step in the above example.
- name: Capture Codex result
  run: echo "Codex said: ${{ steps.codex.outputs['final-message'] }}"
```

Replace `steps.codex` with the `id` assigned to your action step.

## Additional tips

- Run this action after `actions/checkout@v5` so Codex has access to your repository contents.
- If you want Codex to have access to a narrow set of privileged functionality, consider running a local MCP server that can perform these actions and configure Codex to use it.
- If you need more control over the CLI invocation, pass flags through `codex-args` or create a `config.toml` in `codex-home`.
- Once `openai/codex-action` is run once with `openai-api-key`, you can also call `codex` from subsequent scripts in your job. (You can omit `prompt` and `prompt-file` from the action in this case.)

## License

This project is licensed under the [Apache License 2.0](./LICENSE)
