# Security

## Recommendation: run `openai/codex-action` as the last step in a job

Particularly if you run Codex with loose permissions, there are no guarantees what the state of the host is when the `openai/codex-action` completes. For example:

- Codex could have spawned processes that are still running after Codex exits.
- Codex could have overwritten the source code of other actions on the host, such as `actions/github-script`.
- Codex could have written to key configuration files, such as those in your `.git/hooks` folder, with the expectation that privileged processes may run later in the workflow that exercise them.

As shown in the example in the [`README`](../README.md), it is possible to take the output of the `openai/codex-action` and then pass it along to a new job within the workflow.
