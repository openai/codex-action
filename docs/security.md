# Security

## Protecting your `OPENAI_API_KEY`

No doubt your `OPENAI_API_KEY` is an important secret that you do not want to share with the world. **Be sure to use either `drop-sudo` or `unprivileged-user` to ensure it stays secret!**

To underscore the importance of specifying either `drop-sudo` or `unprivileged-user` as the `safety-strategy` for `openai/codex-action`, we provide [an example](../examples/test-sandbox-protections.yml) of how **the combination of read-only access to the filesystem and `sudo` can be used to expose your `OPENAI_API_KEY`**. This often surprises developers, as many expect the combination of "read-only access" and no network to be a sufficient safeguard, but this is not the case in the presence of passwordless `sudo` (which is the default on GitHub-hosted runners). Notably, Linux's [procfs](https://en.wikipedia.org/wiki/Procfs) makes a considerable amount of information available via file-read operations to a user with appropriate privileges.

In the unfortunate event that your API key has leaked, see [this article](https://help.openai.com/en/articles/9047852-how-can-i-delete-my-api-key) that explains how delete/revoke an API key using the [OpenAI Platform's API keys page](https://platform.openai.com/api-keys).

## Recommendation: run `openai/codex-action` as the last step in a job

Particularly if you run Codex with loose permissions, there are no guarantees what the state of the host is when the `openai/codex-action` completes. For example:

- Codex could have spawned processes that are still running after Codex exits.
- Codex could have overwritten the source code of other actions on the host, such as `actions/github-script`.
- Codex could have written to key configuration files, such as those in your `.git/hooks` folder, with the expectation that privileged processes may run later in the workflow that exercise them.

As shown in the example in the [`README`](../README.md), it is possible to take the output of the `openai/codex-action` and then pass it along to a new job within the workflow.
