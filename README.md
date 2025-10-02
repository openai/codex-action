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
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          prompt: ${{ github.event.inputs.prompt }}
```

Provide either `prompt` or `prompt_file`; the other may be left empty. The action streams Codex output to the job logs and exposes the final message as an output named `final_message` for downstream steps.

## Inputs

| Name                      | Required      | Description                                                                                                    | Default          |
| ------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------- | ---------------- |
| `openai_api_key`          | Yes           | Secret used to authenticate the helper proxy with OpenAI. Store it in `secrets` and never hardcode it.         | —                |
| `prompt`                  | Conditionally | Inline prompt text. Provide this or `prompt_file`.                                                             | `""`             |
| `prompt_file`             | Conditionally | Path (relative to the repository root) of a file that contains the prompt. Provide this or `prompt`.           | `""`             |
| `working_directory`       | No            | Directory passed to `codex exec --cd`. Defaults to the repository root.                                         | `""`             |
| `codex_version`           | No            | Version of `@openai/codex` to install.                                                                         | `0.42.0-alpha.3` |
| `codex_args`              | No            | Extra arguments forwarded to `codex exec`. Accepts JSON arrays (`["--flag", "value"]`) or shell-style strings. | `""`             |
| `output_file`             | No            | File where the final Codex message is written. Leave empty to skip writing a file.                              | `""`             |
| `codex_home`              | No            | Directory to use as the Codex CLI home (config/cache). Uses the CLI default when empty.                        | `""`             |
| `safety_strategy`         | No            | Controls how the action restricts Codex privileges. See [Safety strategy](#safety-strategy).                   | `drop_sudo`      |
| `codex_user`              | No            | Username to run Codex as when `safety_strategy` is `unprivileged_user`.                                        | `""`             |

## Safety Strategy

The `safety_strategy` input determines how much access Codex receives on the runner. Choosing the right option is critical, especially when sensitive secrets (like your OpenAI API key) are present.

- **`drop_sudo` (default)** — On Linux and macOS runners, the action revokes the default user’s `sudo` membership before invoking Codex. Codex then runs as that user without superuser privileges. This change lasts for the rest of the job, so subsequent steps cannot rely on `sudo`. This is usually the safest choice on GitHub-hosted runners.
- **`unprivileged_user`** — Runs Codex as the user provided via `codex_user`. Use this if you manage your own runner with a pre-created unprivileged account. Ensure the user can read the repository checkout and any files Codex needs.
- **`read_only`** — Executes Codex in a read-only sandbox. Codex can view files but cannot mutate the filesystem or access the network directly. The OpenAI API key still flows through the proxy, so Codex could read it if it can reach process memory.
- **`unsafe`** — No privilege reduction. Codex runs as the default `runner` user (which typically has `sudo`). Only use this when you fully trust the prompt. On Windows runners this is the only supported choice and the action will fail if another option is provided.

### Operating system support

- **Windows**: GitHub-hosted Windows runners lack a supported sandbox. Set `safety_strategy: unsafe`. The action validates this and exits early otherwise.
- **Linux/macOS**: All options for `safety_strategy` are supported. Again, if you pick `drop_sudo`, remember that later steps in your `job` that rely on `sudo` will fail. If you do need to run code that requires `sudo` after `openai/codex-action` has run, one option is to pipe the output of `openai/codex-action` to a fresh `job` on a new host and to continue your workflow from there.

## Outputs

| Name            | Description                             |
| --------------- | --------------------------------------- |
| `final_message` | Final message returned by `codex exec`. |

You can reference the output from later steps:

```yaml
# steps.codex refers to the `id: codex` step in the above example.
- name: Capture Codex result
  run: echo "Codex said: ${{ steps.codex.outputs.final_message }}"
```

Replace `steps.codex` with the `id` assigned to your action step.

## Additional tips

- Run this action after `actions/checkout@v5` so Codex has access to your repository contents.
- If you want Codex to have access to a narrow set of privileged functionality, consider running a local MCP server that can perform these actions and configure Codex to use it.
- If you need more control over the CLI invocation, pass flags through `codex_args` or create a `config.toml` in `codex_home`.

## License

This project is licensed under the [Apache License 2.0](./LICENSE)
