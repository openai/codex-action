# Security

Running Codex as part of a GitHub workflow can be a powerful tool, but it is important to take precautions to ensure your use of Codex does not become an attack vector for malicious users.

## Limiting who can run your workflow

One of the most fundamental ways to safeguard your workflow is to limit who can run it in the first place. By default, `openai/codex-action` can only be run by a user who has _write_ access to your repository. While you can expand this list via the `allow-users` and `allow-bots` options, do so with caution.

Further, while you may design your workflow such that those with _write_ access can trigger it on content from arbitrary users (i.e., by adding a label to an issue created by an external user) such that you rely on manual approval as a means of defense, it is still important to consider other potential exploits, such as untrusted input.

## Defending against untrusted input

There is a lot of valuable context that can be used to fuel your invocation of Codex to help it do its job, but these same sources can also be used as vehicles for _prompt injection_, co-opting the model into doing things you did not intend. This list of sources includes, but is not limited to:

- **Pull requests**: the title of a pull request is often clear, but it is fairly easy to hide information in a pull request body using an HTML comment (`<!-- -->`) that is readily available to the model but effectively invisible to the user.
- **Commit messages**: a pull request can be composed of many commits. The messages for individual commits often go unnoticed, but could read by Codex.
- **Screenshots** screenshots and other media have been known to be used as vehicles for prompt injection.

<!-- TODO ## Protecting secrets -->

## Look out for API key abuse

If you have effectively opened up your use of `openai/codex-action` to the world by configuring `allow-users: "*"`, you might find yourself the target of API key abuse. For example, if your repository has nothing to do with crypto, but you suddenly see a large influx of GitHub issues asking about mining Bitcoins, there is a good chance that someone is trying to take advantage of the quota for your `OPENAI_API_KEY` to get Codex to do work on their behalf.

## Protecting your `OPENAI_API_KEY`

No doubt your `OPENAI_API_KEY` is an important secret that you do not want to share with the world. **Be sure to use either `drop-sudo` or `unprivileged-user` to ensure it stays secret!** The same trade-offs apply if you wire up Azure OpenAI: when you populate `azure-openai-api-key`, the action exports that value to an environment variable (default `AZURE_OPENAI_API_KEY`) immediately before invoking `codex exec`, so the safeguards below remain essential.

To underscore the importance of specifying either `drop-sudo` or `unprivileged-user` as the `safety-strategy` for `openai/codex-action`, we provide [an example](../examples/test-sandbox-protections.yml) of how **the combination of read-only access to the filesystem and `sudo` can be used to expose your `OPENAI_API_KEY`**. This often surprises developers, as many expect the combination of "read-only access" and no network to be a sufficient safeguard, but this is not the case in the presence of passwordless `sudo` (which is the default on GitHub-hosted runners). Notably, Linux's [procfs](https://en.wikipedia.org/wiki/Procfs) makes a considerable amount of information available via file-read operations to a user with appropriate privileges.

In the unfortunate event that your API key has leaked, see [this article](https://help.openai.com/en/articles/9047852-how-can-i-delete-my-api-key) that explains how to delete/revoke an API key using the [OpenAI Platform's API keys page](https://platform.openai.com/api-keys).

## Recommendation: run `openai/codex-action` as the last step in a job

Particularly if you run Codex with loose permissions, there are no guarantees what the state of the host is when the `openai/codex-action` completes. For example:

- Codex could have spawned processes that are still running after Codex exits.
- Codex could have overwritten the source code of other actions on the host, such as `actions/github-script`.
- Codex could have written to key configuration files, such as those in your `.git/hooks` folder, with the expectation that privileged processes may run later in the workflow that exercise them.

As shown in the example in the [`README`](../README.md), it is possible to take the output of the `openai/codex-action` and then pass it along to a new job within the workflow.
