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
   * When true, trusted GitHub bot actors are allowed without checking
   * collaborator permissions. Other bots must pass the same checks as human
   * users.
   */
  allowBotActors?: boolean;
  /**
   * Comma-separated list of allowed GitHub usernames or '*' to allow all users.
   * Case-insensitive; empty string or undefined disables this override.
   */
  allowUsers?: string;
  /**
   * Comma-separated list of allowed GitHub bot usernames. '*' is not supported.
   * Entries may include or omit the trailing [bot] suffix.
   */
  allowBotUsers?: string;
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
  const allowBotActors = options.allowBotActors ?? false;

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

  // GitHub-built workflows do not have a meaningful collaborator permission
  // level. Only trust the built-in bot actors GitHub owns.
  if (allowBotActors && isTrustedGitHubBotActor(actor)) {
    core.info(`Actor '${actor}' is a trusted GitHub bot account; skipping explicit permission check.`);
    return { status: "approved", actor };
  }

  const allowedBotActors = parseAllowedBotActors(options.allowBotUsers ?? "");
  if (allowedBotActors instanceof Error) {
    return {
      status: "rejected",
      actor,
      reason: allowedBotActors.message,
    };
  }
  if (isBotActor(actor) && allowedBotActors.has(normalizeBotActor(actor))) {
    core.info(`Actor '${actor}' is explicitly allowed via allow-bot-users.`);
    return { status: "approved", actor };
  }

  // Allow-list override: if allowUsers is '*' allow all users. If it is a
  // comma-separated list, allow listed users (case-insensitive) without checking
  // collaborator permissions.
  const allowUsersSpec = (options.allowUsers ?? "").trim();
  if (allowUsersSpec.length > 0) {
    if (allowUsersSpec === "*") {
      core.info("allow-users='*' specified; allowing all users to proceed.");
      return { status: "approved", actor };
    }
    const allowed = new Set(
      allowUsersSpec
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    );
    if (allowed.has(actor.toLowerCase())) {
      core.info(`Actor '${actor}' is explicitly allowed via allow-users.`);
      return { status: "approved", actor };
    }
  }

  const token = options.token ?? getTokenFromEnv();
  if (!token) {
    return {
      status: "rejected",
      actor,
      reason: "A GitHub token is required to check permissions (set GITHUB_TOKEN or GH_TOKEN).",
    };
  }

  const baseUrl = process.env.GITHUB_API_URL?.trim();
  const octokit =
    options.octokit ??
    new Octokit({
      auth: token,
      ...(baseUrl ? { baseUrl } : {}),
    });

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

const TRUSTED_GITHUB_BOT_ACTORS = new Set(["github-actions[bot]"]);

function isTrustedGitHubBotActor(actor: string): boolean {
  return isBotActor(actor) && TRUSTED_GITHUB_BOT_ACTORS.has(normalizeBotActor(actor));
}

function parseAllowedBotActors(allowBotUsers: string): Set<string> | Error {
  const allowed = new Set<string>();
  for (const entry of allowBotUsers.split(",")) {
    const bot = entry.trim();
    if (bot.length === 0) {
      continue;
    }
    if (bot.includes("*")) {
      return new Error("allow-bot-users does not support '*'; list trusted bot usernames explicitly.");
    }
    allowed.add(normalizeBotActor(bot));
  }
  return allowed;
}

function isBotActor(actor: string): boolean {
  return actor.toLowerCase().endsWith("[bot]");
}

function normalizeBotActor(actor: string): string {
  const normalized = actor.toLowerCase();
  return isBotActor(normalized) ? normalized : `${normalized}[bot]`;
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "status" in error && (error as { status?: number }).status === 404,
  );
}
