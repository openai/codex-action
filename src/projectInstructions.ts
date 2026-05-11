import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { checkOutput } from "./checkOutput";
import type { SafetyStrategy } from "./runCodexExec";

export type ProjectInstructionsMode = "default-branch" | "workspace";

type PrepareProjectInstructionsOptions = {
  codexHome: string;
  cd: string;
  workspace: string;
  mode: ProjectInstructionsMode;
  safetyStrategy: SafetyStrategy;
  repository?: string;
  token?: string;
  octokit?: Octokit;
};

const PROJECT_DOC_FILENAMES = ["AGENTS.override.md", "AGENTS.md"] as const;

export async function prepareProjectInstructions({
  codexHome,
  cd,
  workspace,
  mode,
  safetyStrategy,
  repository = process.env.GITHUB_REPOSITORY,
  token = getTokenFromEnv(),
  octokit,
}: PrepareProjectInstructionsOptions): Promise<void> {
  if (mode === "workspace") {
    core.info("Using project instructions from the checked-out workspace.");
    return;
  }

  assertCodexHomeOutsideWorkspace(codexHome, workspace);

  if (!repository || repository.trim().length === 0) {
    throw new Error(
      "GITHUB_REPOSITORY is not set; cannot load default-branch project instructions."
    );
  }
  if (!token) {
    throw new Error(
      "A GitHub token is required to load default-branch project instructions (set GITHUB_TOKEN or GH_TOKEN)."
    );
  }

  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(
      `GITHUB_REPOSITORY must be in the format 'owner/repo', received: '${repository}'.`
    );
  }

  const baseUrl = process.env.GITHUB_API_URL?.trim();
  const client =
    octokit ??
    new Octokit({
      auth: token,
      ...(baseUrl ? { baseUrl } : {}),
    });

  const defaultBranch = await fetchDefaultBranch(client, owner, repo);
  const documents = await fetchTrustedProjectDocuments({
    octokit: client,
    owner,
    repo,
    ref: defaultBranch,
    workspace,
    cd,
  });

  if (documents.length === 0) {
    core.info(
      `No trusted AGENTS instruction files found on ${owner}/${repo}@${defaultBranch}.`
    );
    return;
  }

  const existingGlobalInstructions = await readExistingGlobalInstructions(
    codexHome
  );
  const trustedProjectInstructions = documents
    .map((document) => document.contents.trim())
    .filter((contents) => contents.length > 0)
    .join("\n\n");

  if (trustedProjectInstructions.length === 0) {
    core.info(
      `Trusted AGENTS instruction files on ${owner}/${repo}@${defaultBranch} were empty.`
    );
    return;
  }

  const mergedInstructions =
    existingGlobalInstructions == null
      ? trustedProjectInstructions
      : `${existingGlobalInstructions}\n\n--- project-doc ---\n\n${trustedProjectInstructions}`;

  await writeTrustedInstructions({
    codexHome,
    contents: mergedInstructions,
    safetyStrategy,
  });

  const loadedPaths = documents.map((document) => document.path).join(", ");
  core.info(
    `Loaded trusted default-branch project instructions from ${owner}/${repo}@${defaultBranch}: ${loadedPaths}`
  );
}

function assertCodexHomeOutsideWorkspace(
  codexHome: string,
  workspace: string
): void {
  const resolvedCodexHome = path.resolve(codexHome);
  const resolvedWorkspace = path.resolve(workspace);
  const relative = path.relative(resolvedWorkspace, resolvedCodexHome);
  const isInsideWorkspace =
    relative.length === 0 ||
    (!relative.startsWith("..") && !path.isAbsolute(relative));

  if (isInsideWorkspace) {
    throw new Error(
      `Codex home '${resolvedCodexHome}' must be outside GitHub workspace '${resolvedWorkspace}' when project-instructions-mode is 'default-branch'.`
    );
  }
}

async function fetchDefaultBranch(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<string> {
  const response = await octokit.repos.get({ owner, repo });
  const defaultBranch = response.data.default_branch?.trim();
  if (!defaultBranch) {
    throw new Error(`Could not determine the default branch for ${owner}/${repo}.`);
  }
  return defaultBranch;
}

async function fetchTrustedProjectDocuments({
  octokit,
  owner,
  repo,
  ref,
  workspace,
  cd,
}: {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string;
  workspace: string;
  cd: string;
}): Promise<Array<{ path: string; contents: string }>> {
  const directories = projectDirectories(workspace, cd);
  const documents: Array<{ path: string; contents: string }> = [];

  for (const directory of directories) {
    for (const filename of PROJECT_DOC_FILENAMES) {
      const repoPath = directory.length === 0 ? filename : `${directory}/${filename}`;
      const contents = await fetchRepositoryFile(octokit, owner, repo, ref, repoPath);
      if (contents != null) {
        documents.push({ path: repoPath, contents });
        break;
      }
    }
  }

  return documents;
}

function projectDirectories(workspace: string, cd: string): Array<string> {
  const workspaceRoot = path.resolve(workspace);
  const cwd = path.resolve(cd);
  const relative = path.relative(workspaceRoot, cwd);

  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Working directory '${cwd}' must be inside GitHub workspace '${workspaceRoot}' when project-instructions-mode is 'default-branch'.`
    );
  }

  if (relative.length === 0) {
    return [""];
  }

  const directories = [""];
  const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
  let current = "";
  for (const segment of segments) {
    current = current.length === 0 ? segment : `${current}/${segment}`;
    directories.push(current);
  }
  return directories;
}

async function fetchRepositoryFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  repoPath: string
): Promise<string | null> {
  try {
    const response = await octokit.repos.getContent({
      owner,
      repo,
      path: repoPath,
      ref,
    });
    const data = response.data;
    if (Array.isArray(data) || data.type !== "file" || data.encoding !== "base64") {
      return null;
    }
    return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function readExistingGlobalInstructions(
  codexHome: string
): Promise<string | null> {
  for (const filename of PROJECT_DOC_FILENAMES) {
    try {
      const contents = await fs.readFile(path.join(codexHome, filename), "utf8");
      const trimmed = contents.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    } catch {
      // Keep walking through the supported global instruction filenames.
    }
  }
  return null;
}

async function writeTrustedInstructions({
  codexHome,
  contents,
  safetyStrategy,
}: {
  codexHome: string;
  contents: string;
  safetyStrategy: SafetyStrategy;
}): Promise<void> {
  const destination = path.join(codexHome, "AGENTS.override.md");

  if (safetyStrategy === "unprivileged-user") {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agents"));
    try {
      const tempPath = path.join(tempDir, "AGENTS.override.md");
      await fs.writeFile(tempPath, `${contents}\n`, "utf8");
      await checkOutput(["sudo", "mv", tempPath, destination]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    return;
  }

  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(destination, `${contents}\n`, "utf8");
}

function getTokenFromEnv(): string {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return token && token.trim().length > 0 ? token : "";
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "status" in error &&
      (error as { status?: number }).status === 404
  );
}
