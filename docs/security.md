# Security

Running Codex as part of a GitHub workflow can be a powerful tool, but it is important to take precautions to ensure your use of Codex does not become an attack vector for malicious users.

## Limiting who can run your workflow

One of the most fundamental ways to safeguard your workflow is to limit who can run it in the first place. By default, `openai/codex-action` can only be run by a user who has _write_ access to your repository. While you can expand this list via `allow-users`, allow trusted GitHub bot actors (`github-actions[bot]`) via `allow-bots`, or list custom trusted bots via `allow-bot-users`, do so with caution. `allow-bot-users` does not support `*`; list each trusted bot explicitly.

Further, while you may design your workflow such that those with _write_ access can trigger it on content from arbitrary users (i.e., by adding a label to an issue created by an external user) such that you rely on manual approval as a means of defense, it is still important to consider other potential exploits, such as untrusted input.

## Defending against untrusted input

There is a lot of valuable context that can be used to fuel your invocation of Codex to help it do its job, but these same sources can also be used as vehicles for _prompt injection_, co-opting the model into doing things you did not intend. This list of sources includes, but is not limited to:

- **Pull requests**: the title of a pull request is often clear, but it is fairly easy to hide information in a pull request body using an HTML comment (`<!-- -->`) that is readily available to the model but effectively invisible to the user.
- **Commit messages**: a pull request can be composed of many commits. The messages for individual commits often go unnoticed, but could read by Codex.
- **Repository instruction files**: when Codex operates on pull request-controlled content, files such as `AGENTS.md`, `AGENTS.override.md`, or configured fallback project docs from that content should be considered part of the untrusted input surface.
- **Screenshots**: screenshots and other media have been known to be used as vehicles for prompt injection.

## Limit command permissions

Use `permission-profile` to select the narrowest filesystem and network policy that still lets Codex
complete the task. For workflows that edit the checkout, prefer the built-in `:workspace` profile
over the legacy `sandbox: workspace-write` setting. Use a custom profile when the workflow needs a
more specific policy. See the
[Codex permissions documentation](https://developers.openai.com/codex/permissions) for the available
built-in profiles and configuration schema.

Permission profiles constrain commands that Codex runs; they do not replace the action's
`safety-strategy`, which controls the privileges of the Codex process itself. Continue to use
`drop-sudo` or a deliberately configured `unprivileged-user` when a profile grants filesystem writes
or network access.

Permission profiles and the legacy `sandbox` input do not compose. The action rejects both inputs
together, but a `sandbox_mode` setting in `codex-args` or a loaded `config.toml` also opts Codex into
the legacy sandbox model. Review every loaded configuration layer when a workflow is expected to use
a permission profile.

## Avoid shell injection in workflow steps

GitHub Actions expands `${{ ... }}` expressions before the shell runs your `run:` script. If you splice untrusted values such as branch names, issue titles, comment bodies, or action inputs directly into the script, those values can break shell quoting and execute arbitrary commands.

Instead, pass those values through `env:` and quote the shell variables that consume them:

```yaml
- name: Safe shell usage
  env:
    PR_BASE_REF: ${{ github.event.pull_request.base.ref }}
  run: |
    git fetch origin "$PR_BASE_REF"
```

<!-- TODO ## Protecting secrets -->

## Look out for API key abuse

If you have effectively opened up your use of `openai/codex-action` to the world by configuring `allow-users: "*"`, you might find yourself the target of API key abuse. For example, if your repository has nothing to do with crypto, but you suddenly see a large influx of GitHub issues asking about mining Bitcoins, there is a good chance that someone is trying to take advantage of the quota for your `OPENAI_API_KEY` to get Codex to do work on their behalf.

## Protecting authentication secrets

Your Platform API key and ChatGPT personal access token are both sensitive credentials. **Use either `drop-sudo` or `unprivileged-user` to keep the selected credential out of reach of model-invoked code.**

The action does not pass either credential to `codex exec`. It gives the secret to the loopback Responses proxy through standard input, after removing the input variable from the proxy's environment. For `codex-access-token`, a short-lived preflight first resolves the ChatGPT account and FedRAMP routing context; only that non-secret context is written to Codex's proxy configuration. This keeps the personal access token out of model-invoked tool and subprocess environments.

To underscore the importance of specifying either `drop-sudo` or `unprivileged-user` as the `safety-strategy` for `openai/codex-action`, we provide [an example](../examples/test-sandbox-protections.yml) of how **the combination of read-only access to the filesystem and `sudo` can be used to expose a credential from proxy process memory**. This often surprises developers, as many expect the combination of "read-only access" and no network to be a sufficient safeguard, but this is not the case in the presence of passwordless `sudo` (which is the default on GitHub-hosted runners). Notably, Linux's [procfs](https://en.wikipedia.org/wiki/Procfs) makes a considerable amount of information available via file-read operations to a user with appropriate privileges.

If a credential leaks, revoke it immediately. Platform API keys can be deleted from the [OpenAI Platform API keys page](https://platform.openai.com/api-keys); revoke ChatGPT personal access tokens from the workspace where they were created.

## Recommendation: run `openai/codex-action` as the last step in a job

Particularly if you run Codex with loose permissions, there are no guarantees what the state of the host is when the `openai/codex-action` completes. For example:

- Codex could have spawned processes that are still running after Codex exits.
- Codex could have overwritten the source code of other actions on the host, such as `actions/github-script`.
- Codex could have written to key configuration files, such as those in your `.git/hooks` folder, with the expectation that privileged processes may run later in the workflow that exercise them.

As shown in the example in the [`README`](../README.md), it is possible to take the output of the `openai/codex-action` and then pass it along to a new job within the workflow.
