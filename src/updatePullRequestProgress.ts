import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { readFile } from "node:fs/promises";

export type ProgressStatus = "running" | "completed" | "failed";

const MARKER = "<!-- codex-action-progress -->";

export async function updatePullRequestProgress({
  status,
  token = process.env.GITHUB_TOKEN ?? "",
  repository = process.env.GITHUB_REPOSITORY ?? "",
  eventPath = process.env.GITHUB_EVENT_PATH ?? "",
  octokit,
}: {
  status: ProgressStatus;
  token?: string;
  repository?: string;
  eventPath?: string;
  octokit?: Octokit;
}): Promise<void> {
  if (!eventPath) {
    core.info("Skipping progress comment: this is not a pull request event.");
    return;
  }
  if (!repository.includes("/")) {
    throw new Error("GITHUB_REPOSITORY must be in the format owner/repo.");
  }
  if (!token) {
    throw new Error("A GitHub token is required to post a progress comment.");
  }

  const event = JSON.parse(await readFile(eventPath, "utf8")) as {
    pull_request?: { number?: number };
  };
  const issueNumber = event.pull_request?.number;
  if (!issueNumber) {
    core.info("Skipping progress comment: this is not a pull request event.");
    return;
  }

  const [owner, repo] = repository.split("/", 2);
  const client = octokit ?? new Octokit({ auth: token });
  const body = `${MARKER}\n${progressMessage(status)}`;
  const comments = await client.paginate(client.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const existing = comments.find(
    (comment) =>
      comment.user?.login === "github-actions[bot]" &&
      comment.body?.includes(MARKER)
  );

  if (existing) {
    await client.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await client.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  }
}

function progressMessage(status: ProgressStatus): string {
  switch (status) {
    case "running":
      return "🤖 Codex is working on this pull request.";
    case "completed":
      return "✅ Codex completed its work on this pull request.";
    case "failed":
      return "❌ Codex did not complete successfully on this pull request.";
  }
}
