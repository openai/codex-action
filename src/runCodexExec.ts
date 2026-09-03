import { spawn } from "child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import os from "os";
import type { Readable } from "stream";
import { setOutput } from "@actions/core";
import { checkOutput } from "./checkOutput";
import { captureLinuxRunnerCredentials } from "./linuxCredentials";

const LINUX_DROP_SUDO_SCRIPT = String.raw`
node="$1"
action="$2"
user="$3"
uid="$4"
home="$5"
runner_path="$6"
node_options="$7"
runner_credentials="$8"
shift 8

if [ ! -x /usr/bin/setpriv ]; then
  echo "Linux drop-sudo requires /usr/bin/setpriv." >&2
  exit 1
fi

nobody_gid="$(/usr/bin/id -g nobody 2>/dev/null)" || {
  echo "Linux drop-sudo requires an unprivileged nobody account." >&2
  exit 1
}
case "$nobody_gid" in
  ''|*[!0-9]*|0)
    echo "Linux drop-sudo could not resolve a safe nobody primary group." >&2
    exit 1
    ;;
esac
group_entry="$(/usr/bin/getent group "$nobody_gid" 2>/dev/null)" || {
  echo "Linux drop-sudo could not resolve the nobody primary group." >&2
  exit 1
}
case "$group_entry" in
  nobody:*|nogroup:*) ;;
  *)
    echo "Linux drop-sudo refuses an unexpected nobody primary group." >&2
    exit 1
    ;;
esac

/usr/bin/env -u NODE_OPTIONS "$node" "$action" drop-sudo --root-phase --user "$user" --group sudo --runner-credentials "$runner_credentials" || exit $?
unsafe_nobody_socket="$(/usr/bin/find /run -type s -uid 0 -gid "$nobody_gid" -perm -020 -print -quit)" || {
  echo "Linux drop-sudo could not verify the nobody primary group." >&2
  exit 1
}
if [ -n "$unsafe_nobody_socket" ]; then
  echo "Linux drop-sudo refuses an unsafe nobody primary group." >&2
  exit 1
fi
if /usr/bin/sudo -n -u "$user" -- /usr/bin/sudo -n true 2>/dev/null; then
  echo "Expected sudo to be disabled, but sudo succeeded." >&2
  exit 1
fi
echo "Confirmed the standard sudo probe is disabled."

set -- /usr/bin/setpriv \
  --reuid="$uid" \
  --regid="$nobody_gid" \
  --clear-groups \
  --no-new-privs \
  --bounding-set=-all \
  --inh-caps=-all \
  --ambient-caps=-all \
  -- /usr/bin/env \
  -u SUDO_COMMAND -u SUDO_USER -u SUDO_UID -u SUDO_GID \
  "HOME=$home" "USER=$user" "LOGNAME=$user" "PATH=$runner_path" \
  "NODE_OPTIONS=$node_options" \
  "$@"
echo "Launching Codex with no_new_privs and empty capability sets."
exec "$@"
`;

export type PromptSource =
  | {
      type: "inline";
      content: string;
    }
  | {
      type: "file";
      path: string;
    };

export type SafetyStrategy =
  | "drop-sudo"
  | "read-only"
  | "unprivileged-user"
  | "unsafe";

export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

type PermissionSelection =
  | { type: "sandbox"; mode: SandboxMode }
  | { type: "profile"; name: string };

export type OutputSchemaSource =
  | {
      type: "file";
      path: string;
    }
  | {
      type: "inline";
      content: string;
    };

/**
 * Builds and runs a `codex exec` command, writes the prompt to its standard input, and publishes
 * the command's final message as the action output.
 *
 * Authentication is intentionally outside this function. The composite action starts or reuses
 * the Responses API proxy and writes the corresponding Codex configuration before invoking this
 * command. Keeping that setup separate also lets tests put a fake `codex` executable on `PATH` to
 * verify command construction and output handling without an API key or network request.
 */
export async function runCodexExec({
  prompt,
  codexHome,
  cd,
  extraArgs,
  explicitOutputFile,
  outputSchema,
  model,
  effort,
  safetyStrategy,
  codexUser,
  sandbox,
  permissionProfile,
}: {
  prompt: PromptSource;
  codexHome: string | null;
  cd: string;
  extraArgs: Array<string>;
  explicitOutputFile: string | null;
  outputSchema: OutputSchemaSource | null;
  model: string | null;
  effort: string | null;
  safetyStrategy: SafetyStrategy;
  codexUser: string | null;
  sandbox: SandboxMode | null;
  permissionProfile: string | null;
}): Promise<void> {
  let input: string;
  switch (prompt.type) {
    case "inline":
      input = prompt.content;
      break;
    case "file":
      input = await readFile(prompt.path, "utf8");
      break;
  }

  const runAsUser: string | null =
    safetyStrategy === "unprivileged-user" ? codexUser : null;

  let outputFile: OutputFile;
  if (explicitOutputFile != null) {
    outputFile = { type: "explicit", file: explicitOutputFile };
  } else {
    outputFile = await createTempOutputFile({ runAsUser });
  }

  const resolvedOutputSchema = await resolveOutputSchema(
    outputSchema,
    runAsUser
  );
  const permissionSelection = determinePermissionSelection({
    safetyStrategy,
    requestedSandbox: sandbox,
    permissionProfile,
    extraArgs,
  });

  const command: Array<string> = [];

  const isLinuxDropSudo =
    safetyStrategy === "drop-sudo" && process.platform === "linux";
  let pathToCodex = "codex";
  if (isLinuxDropSudo) {
    const uid = process.getuid?.();
    if (uid == null || uid === 0) {
      throw new Error("Linux drop-sudo requires a non-root runner user.");
    }
    const runnerCredentials = captureLinuxRunnerCredentials();

    try {
      await checkOutput(["/usr/bin/sudo", "-n", "true"]);
    } catch {
      throw new Error(
        "Linux drop-sudo requires passwordless sudo before Codex starts. It cannot run again after sudo has been removed; use a separate job."
      );
    }

    pathToCodex = (await checkOutput(["which", "codex"])).trim();
    if (!pathToCodex) {
      throw new Error("could not find 'codex' in PATH");
    }

    const user = os.userInfo();
    command.push(
      "/usr/bin/sudo",
      "-n",
      "-E",
      "--",
      "/usr/bin/env",
      "-u",
      "ENV",
      "-u",
      "BASH_ENV",
      "-u",
      "SHELLOPTS",
      "/bin/sh",
      "-c",
      LINUX_DROP_SUDO_SCRIPT,
      "codex-action-drop-sudo",
      process.execPath,
      process.argv[1],
      user.username,
      String(uid),
      process.env.HOME ?? user.homedir,
      process.env.PATH ?? "",
      process.env.NODE_OPTIONS ?? "",
      JSON.stringify(runnerCredentials)
    );
  } else if (safetyStrategy === "unprivileged-user") {
    if (codexUser == null) {
      throw new Error(
        "codexUser must be specified when using the 'unprivileged-user' safety strategy."
      );
    }

    if (process.platform === "win32") {
      throw new Error(
        "the 'unprivileged-user' safety strategy is not supported on Windows."
      );
    }

    // We are currently running as a privileged user, but `codexUser` will run
    // with a different $PATH variable, so we need to find the full path to
    // `codex`.
    pathToCodex = (await checkOutput(["which", "codex"])).trim();
    if (!pathToCodex) {
      throw new Error("could not find 'codex' in PATH");
    }

    command.push("sudo", "-u", codexUser, "--");
  }

  command.push(
    pathToCodex,
    "exec",
    "--skip-git-repo-check",
    "--cd",
    cd,
    "--output-last-message",
    outputFile.file
  );

  if (resolvedOutputSchema != null) {
    command.push("--output-schema", resolvedOutputSchema.file);
  }

  if (model != null) {
    command.push("--model", model);
  }

  if (effort != null) {
    // https://github.com/openai/codex/blob/00debb6399eb51c4b9273f0bc012912c42fe6c91/docs/config.md#config
    // https://github.com/openai/codex/blob/00debb6399eb51c4b9273f0bc012912c42fe6c91/docs/config.md#model_reasoning_effort
    command.push("--config", `model_reasoning_effort="${effort}"`);
  }

  command.push(...extraArgs);

  switch (permissionSelection.type) {
    case "sandbox":
      command.push("--sandbox", permissionSelection.mode);
      break;
    case "profile":
      command.push(
        "--config",
        `default_permissions=${JSON.stringify(permissionSelection.name)}`
      );
      break;
  }

  const env = { ...process.env };
  if (!env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) {
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "codex_github_action";
  }
  let extraEnv = "";
  if (codexHome != null) {
    env.CODEX_HOME = codexHome;
    extraEnv = `CODEX_HOME=${codexHome} `;
  }

  // Split the `program` from the `args` for `spawn()`.
  const program = command.shift()!;
  console.log(
    `Running: ${extraEnv}${program} ${command
      .map((a) => JSON.stringify(a))
      .join(" ")}`
  );
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(program, command, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout.pipe(process.stdout, { end: false });
      child.stderr.pipe(process.stderr, { end: false });
      child.stdin.write(input);
      child.stdin.end();

      const closeOutputStreams = () => {
        child.stdout.unpipe(process.stdout);
        child.stderr.unpipe(process.stderr);
        child.stdout.destroy();
        child.stderr.destroy();
      };

      child.once("error", (err) => {
        closeOutputStreams();
        reject(err);
      });

      child.once("exit", async (code) => {
        await drainOutputStreams([child.stdout, child.stderr]);
        closeOutputStreams();
        if (code !== 0) {
          reject(new Error(`${program} exited with code ${code}`));
          return;
        }

        try {
          await finalizeExecution(outputFile, runAsUser);
          resolve(undefined);
        } catch (err) {
          reject(err);
        }
      });
    });
  } finally {
    await cleanupOutputSchema(resolvedOutputSchema);
  }
}

const OUTPUT_DRAIN_QUIET_MS = 25;
const OUTPUT_DRAIN_TIMEOUT_MS = 1_000;

/**
 * Lets libuv deliver output that was already buffered when the direct child exited. Descendants
 * may still own the write ends, so EOF cannot be the completion condition. The absolute bound
 * keeps a descendant that continuously writes (or a blocked runner log destination) from hanging
 * the action forever.
 */
function drainOutputStreams(streams: ReadonlyArray<Readable>): Promise<void> {
  return new Promise((resolve) => {
    let quietHandle: NodeJS.Timeout;

    const onData = () => {
      scheduleQuietCheck();
    };
    for (const stream of streams) {
      stream.on("data", onData);
    }

    const finish = () => {
      clearTimeout(quietHandle);
      clearTimeout(timeoutHandle);
      for (const stream of streams) {
        stream.off("data", onData);
      }
      resolve();
    };

    const scheduleQuietCheck = () => {
      clearTimeout(quietHandle);
      quietHandle = setTimeout(() => {
        const streamsAreDrained = streams.every(
          (stream) =>
            stream.destroyed ||
            (stream.readableLength === 0 && stream.readableFlowing !== false)
        );
        if (streamsAreDrained) {
          finish();
          return;
        }
        scheduleQuietCheck();
      }, OUTPUT_DRAIN_QUIET_MS);
    };

    const timeoutHandle = setTimeout(finish, OUTPUT_DRAIN_TIMEOUT_MS);
    scheduleQuietCheck();
  });
}

async function finalizeExecution(
  outputFile: OutputFile,
  runAsUser: string | null
): Promise<void> {
  try {
    let lastMessage: string;
    if (runAsUser == null) {
      lastMessage = await readFile(outputFile.file, "utf8");
    } else {
      lastMessage = await checkOutput([
        "sudo",
        "-u",
        runAsUser,
        "cat",
        outputFile.file,
      ]);
    }
    setOutput("final-message", lastMessage);
  } finally {
    await cleanupTempOutput(outputFile, runAsUser);
  }
}

type OutputFile =
  | {
      type: "explicit";
      file: string;
    }
  | {
      type: "temp";
      file: string;
    };

type ResolvedOutputSchema =
  | {
      type: "explicit";
      file: string;
    }
  | {
      type: "temp";
      file: string;
      dir: string;
    };

async function createTempOutputFile({
  runAsUser,
}: {
  runAsUser: string | null;
}): Promise<OutputFile> {
  const dir = await createTempDir("codex-exec-", runAsUser);
  return { type: "temp", file: path.join(dir, "output.md") };
}

async function cleanupTempOutput(
  outputFile: OutputFile,
  runAsUser: string | null
): Promise<void> {
  switch (outputFile.type) {
    case "explicit":
      // Do not delete user-specified output files.
      return;
    case "temp": {
      const { file } = outputFile;
      if (runAsUser == null) {
        const dir = path.dirname(file);
        await rm(dir, { recursive: true, force: true });
      } else {
        await checkOutput(["sudo", "rm", "-rf", path.dirname(file)]);
      }
      break;
    }
  }
}

async function resolveOutputSchema(
  schema: OutputSchemaSource | null,
  runAsUser: string | null
): Promise<ResolvedOutputSchema | null> {
  if (schema == null) {
    return null;
  }

  switch (schema.type) {
    case "file":
      return { type: "explicit", file: schema.path };
    case "inline": {
      const dir = await createTempDir("codex-output-schema-", runAsUser);
      const file = path.join(dir, "schema.json");
      await writeFile(file, schema.content);
      return { type: "temp", file, dir };
    }
  }
}

async function cleanupOutputSchema(
  schema: ResolvedOutputSchema | null
): Promise<void> {
  if (schema == null) {
    return;
  }

  switch (schema.type) {
    case "explicit":
      return;
    case "temp":
      await rm(schema.dir, { recursive: true, force: true });
      return;
  }
}

async function createTempDir(
  prefix: string,
  runAsUser: string | null
): Promise<string> {
  if (runAsUser == null) {
    return await mkdtemp(path.join(os.tmpdir(), prefix));
  } else {
    return (
      await checkOutput([
        "sudo",
        "-u",
        runAsUser,
        "mktemp",
        "-d",
        "-t",
        `${prefix}.XXXXXX`,
      ])
    ).trim();
  }
}

function determinePermissionSelection({
  safetyStrategy,
  requestedSandbox,
  permissionProfile,
  extraArgs,
}: {
  safetyStrategy: SafetyStrategy;
  requestedSandbox: SandboxMode | null;
  permissionProfile: string | null;
  extraArgs: Array<string>;
}): PermissionSelection {
  if (permissionProfile != null && requestedSandbox != null) {
    throw new Error(
      "`permission-profile` and `sandbox` are mutually exclusive. Permission profiles do not compose with legacy sandbox settings."
    );
  }
  if (permissionProfile != null && safetyStrategy === "read-only") {
    throw new Error(
      "`permission-profile` cannot be combined with the `read-only` safety strategy because that strategy forces the legacy read-only sandbox."
    );
  }
  const effectiveSandboxReadOnly =
    safetyStrategy === "read-only" || requestedSandbox === "read-only";
  if (
    (permissionProfile != null || effectiveSandboxReadOnly) &&
    extraArgs.some(
      (arg) =>
        arg === "--dangerously-bypass-approvals-and-sandbox" ||
        arg === "--yolo" ||
        arg === "--full-auto"
    )
  ) {
    throw new Error(
      "`codex-args` cannot bypass sandbox protections when a `permission-profile` or read-only sandbox is selected."
    );
  }
  if (permissionProfile != null && extraArgsSelectSandbox(extraArgs)) {
    throw new Error(
      "`permission-profile` cannot be combined with a sandbox override in `codex-args`."
    );
  }
  const customPermissionProfile =
    permissionProfile != null && !permissionProfile.startsWith(":");
  if (
    customPermissionProfile &&
    extraArgs.some(
      (arg) =>
        arg === "--image" ||
        arg.startsWith("--image=") ||
        (arg.startsWith("-i") && !arg.startsWith("--"))
    )
  ) {
    throw new Error(
      "`codex-args` cannot attach local images with a custom permission profile because image loading does not enforce its filesystem restrictions."
    );
  }
  if (safetyStrategy !== "unsafe" || permissionProfile != null) {
    validateProtectedExtraArgs(extraArgs, customPermissionProfile);
  }
  if (safetyStrategy === "read-only") {
    return { type: "sandbox", mode: "read-only" };
  }
  if (permissionProfile != null) {
    return { type: "profile", name: permissionProfile };
  }
  return { type: "sandbox", mode: requestedSandbox ?? "workspace-write" };
}

const RESTRICTED_CONFIG_ROOTS = new Set([
  "agents",
  "approval_policy",
  "approvals_reviewer",
  "apps_mcp_product_sku",
  "auto_review",
  "chatgpt_base_url",
  "debug",
  "default_permissions",
  "experimental_realtime_webrtc_call_base_url",
  "experimental_realtime_ws_base_url",
  "hooks",
  "marketplaces",
  "mcp_servers",
  "model_provider",
  "model_providers",
  "notify",
  "openai_base_url",
  "oss_provider",
  "otel",
  "permissions",
  "plugins",
  "profile",
  "profiles",
  "projects",
  "sandbox_mode",
  "sandbox_workspace_write",
  "shell_environment_policy",
  "use_legacy_landlock",
]);

const CUSTOM_PROFILE_RESTRICTED_CONFIG_ROOTS = new Set([
  "experimental_compact_prompt_file",
  "model_catalog_json",
  "model_instructions_file",
]);

function validateProtectedExtraArgs(
  args: Array<string>,
  customPermissionProfile: boolean
): void {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (
      arg === "--dangerously-bypass-hook-trust" ||
      arg.startsWith("--dangerously-bypass-hook-trust=") ||
      arg === "--approve-for-me" ||
      arg.startsWith("--approve-for-me=") ||
      arg === "--not-so-yolo" ||
      arg.startsWith("--not-so-yolo=") ||
      arg === "--add-dir" ||
      arg.startsWith("--add-dir=") ||
      arg === "--oss" ||
      arg.startsWith("--oss=") ||
      arg === "--local-provider" ||
      arg.startsWith("--local-provider=") ||
      arg === "--ignore-user-config" ||
      arg.startsWith("--ignore-user-config=") ||
      arg === "--ignore-rules" ||
      arg.startsWith("--ignore-rules=") ||
      arg === "--profile" ||
      arg.startsWith("--profile=") ||
      (arg.startsWith("-p") && !arg.startsWith("--"))
    ) {
      throw new Error(
        `\`codex-args\` cannot use ${arg} with a protected safety strategy or permission profile.`
      );
    }

    if (arg === "--enable" || arg.startsWith("--enable=")) {
      const feature =
        arg === "--enable" ? args[++index] : arg.slice("--enable=".length);
      if (feature !== "use_legacy_landlock") {
        throw new Error(
          "`codex-args` can only enable `use_legacy_landlock` with a protected safety strategy or permission profile."
        );
      }
      continue;
    }
    if (arg === "--disable" || arg.startsWith("--disable=")) {
      throw new Error(
        "`codex-args` cannot disable Codex features with a protected safety strategy or permission profile."
      );
    }

    let override: string | undefined;
    if (arg === "--config" || arg === "-c") {
      override = args[++index];
    } else if (arg.startsWith("--config=")) {
      override = arg.slice("--config=".length);
    } else if (arg.startsWith("-c") && !arg.startsWith("--")) {
      override = arg.slice("-c".length);
      if (override.startsWith("=")) {
        override = override.slice(1);
      }
    } else {
      continue;
    }

    const equalsIndex = override?.indexOf("=") ?? -1;
    const key = override?.slice(0, equalsIndex).trim();
    if (
      equalsIndex < 1 ||
      key === undefined ||
      !/^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/.test(key)
    ) {
      throw new Error(
        "`codex-args` contains an invalid or ambiguous configuration override for a protected safety strategy or permission profile."
      );
    }

    const root = key.split(".", 1)[0];
    if (
      RESTRICTED_CONFIG_ROOTS.has(root) ||
      (customPermissionProfile &&
        CUSTOM_PROFILE_RESTRICTED_CONFIG_ROOTS.has(root)) ||
      (root === "features" && key !== "features.use_legacy_landlock")
    ) {
      throw new Error(
        `\`codex-args\` cannot override \`${key}\` with a protected safety strategy or permission profile.`
      );
    }
  }
}

function extraArgsSelectSandbox(args: Array<string>): boolean {
  return args.some((arg, index) => {
    if (
      arg === "--sandbox" ||
      arg.startsWith("--sandbox=") ||
      (arg.startsWith("-s") && !arg.startsWith("--"))
    ) {
      return true;
    }
    if (arg === "--config" || arg === "-c") {
      return configOverrideSelectsSandbox(args[index + 1]);
    }
    if (arg.startsWith("--config=")) {
      return configOverrideSelectsSandbox(arg.slice("--config=".length));
    }
    if (arg.startsWith("-c") && !arg.startsWith("--")) {
      const override = arg.slice("-c".length);
      return configOverrideSelectsSandbox(
        override.startsWith("=") ? override.slice(1) : override
      );
    }
    return false;
  });
}

function configOverrideSelectsSandbox(override: string | undefined): boolean {
  const key = override?.trimStart().split(/[=.]/, 1)[0].trim();
  return key === "sandbox_mode" || key === "sandbox_workspace_write";
}
