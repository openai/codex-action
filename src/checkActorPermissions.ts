import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";

export type WriteAccessCheck =
  | {
      status: "approved";
      actor: string;
    }
  | {
      status: "rejected";
      actor: string;
      reason: string;
    };

type EnsureWriteAccessOptions = {
  octokit?: Octokit;
  token?: string;
  actor?: string;
  repository?: string;
  /**
   * When true (default), bot actors such as dependabot are allowed without
   * checking collaborator permissions. Set to false to require bots to pass the
   * same checks as human users.
   */
  allowBotActors?: boolean;
};

/**
 * Checks that the GitHub actor which triggered the current workflow has write
 * access to the repository.
 */
export async function ensureActorHasWriteAccess(
  options: EnsureWriteAccessOptions = {},
): Promise<WriteAccessCheck> {
  const actor = options.actor ?? process.env.GITHUB_ACTOR;
  const repository = options.repository ?? process.env.GITHUB_REPOSITORY;
  const allowBotActors = options.allowBotActors ?? true;

  if (!actor || actor.trim().length === 0) {
    return {
      status: "rejected",
      actor: actor ?? "<unknown>",
      reason: "GITHUB_ACTOR is not set; cannot determine triggering user.",
    };
  }

  if (!repository || repository.trim().length === 0) {
    return {
      status: "rejected",
      actor,
      reason: "GITHUB_REPOSITORY is not set; cannot determine target repository.",
    };
  }

  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    return {
      status: "rejected",
      actor,
      reason: `GITHUB_REPOSITORY must be in the format 'owner/repo', received: '${repository}'.`,
    };
  }

  // GitHub-built workflows (e.g. dependabot, github-actions[bot]) do not have a
  // meaningful write permission concept. They implicitly run with the token's permissions.
  if (allowBotActors && actor.endsWith("[bot]")) {
    core.info(`Actor '${actor}' is a bot account; skipping explicit permission check.`);
    return { status: "approved", actor };
  }

  const token = options.token ?? getTokenFromEnv();
  if (!token) {
    return {
      status: "rejected",
      actor,
      reason: "A GitHub token is required to check permissions (set GITHUB_TOKEN or GH_TOKEN).",
    };
  }

  const octokit = options.octokit ?? new Octokit({ auth: token });

  core.info(`Checking write access for actor '${actor}' on ${owner}/${repo}`);

  let permission: string;
  try {
    const response = await octokit.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username: actor,
    });
    permission = response.data.permission ?? "none";
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        status: "rejected",
        actor,
        reason: `Actor '${actor}' is not a collaborator on ${owner}/${repo}; write access is required.`,
      };
    }

    const message =
      error instanceof Error
        ? error.message
        : "Failed to verify permissions for actor due to unknown error.";

    return {
      status: "rejected",
      actor,
      reason: `Failed to verify permissions for '${actor}': ${message}`,
    };
  }

  core.info(`Actor '${actor}' has permission level '${permission}'.`);

  if (permission === "admin" || permission === "write" || permission === "maintain") {
    return { status: "approved", actor };
  }

  return {
    status: "rejected",
    actor,
    reason: `Actor '${actor}' must have write access to ${owner}/${repo}. Detected permission: '${permission}'.`,
  };
}

function getTokenFromEnv(): string {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return token && token.trim().length > 0 ? token : "";
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "status" in error && (error as { status?: number }).status === 404,
  );
}
