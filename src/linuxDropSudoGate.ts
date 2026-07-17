import { randomBytes } from "node:crypto";
import { type ChildProcess } from "node:child_process";
import { type LinuxCodexIdentity } from "./linuxDropSudo";
import {
  ENV_PATH,
  SETPRIV_PATH,
  SHELL_PATH,
  SUDO_PATH,
} from "./linuxSystemPaths";

const GATE_SCRIPT = [
  `printf '%s\\n' "$1"`,
  `IFS= read -r gate || exit 125`,
  `[ "$gate" = "$2" ] || exit 125`,
  `shift 2`,
  `exec "$@"`,
].join("; ");

export interface GatedCodexCommand {
  program: string;
  args: Array<string>;
  readyToken: string;
  goToken: string;
}

/** Builds a command that stops at a trusted shell gate after the identity transition. */
export function buildGatedCodexCommand({
  identity,
  codexArgs,
}: {
  identity: LinuxCodexIdentity;
  codexArgs: Array<string>;
}): GatedCodexCommand {
  const readyToken = `codex-action-ready-${randomBytes(16).toString("hex")}`;
  const goToken = `codex-action-go-${randomBytes(16).toString("hex")}`;
  const args = [
    "-n",
    "-E",
    "--",
    SETPRIV_PATH,
    `--reuid=${identity.uid}`,
    `--regid=${identity.gid}`,
    "--clear-groups",
    "--no-new-privs",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--bounding-set=-all",
    "--",
    ENV_PATH,
    "-u",
    "SUDO_COMMAND",
    "-u",
    "SUDO_USER",
    "-u",
    "SUDO_UID",
    "-u",
    "SUDO_GID",
    "-u",
    "GITHUB_ENV",
    "-u",
    "GITHUB_PATH",
    "-u",
    "GITHUB_OUTPUT",
    "-u",
    "GITHUB_STEP_SUMMARY",
    "-u",
    "ENV",
    "-u",
    "BASH_ENV",
    "-u",
    "SHELLOPTS",
    `HOME=${identity.home}`,
    `USER=${identity.user}`,
    `LOGNAME=${identity.user}`,
    `PATH=${process.env.PATH ?? ""}`,
  ];

  identity.gitSafeDirectories.forEach((directory, index) => {
    args.push(
      `GIT_CONFIG_KEY_${index}=safe.directory`,
      `GIT_CONFIG_VALUE_${index}=${directory}`
    );
  });
  args.push(
    `GIT_CONFIG_COUNT=${identity.gitSafeDirectories.length}`,
    SHELL_PATH,
    "-c",
    GATE_SCRIPT,
    "codex-action-gate",
    readyToken,
    goToken,
    identity.codexExecutable,
    ...codexArgs
  );

  return { program: SUDO_PATH, args, readyToken, goToken };
}

export async function waitForLinuxGate(
  child: ChildProcess,
  readyToken: string
): Promise<void> {
  const stdout = child.stdout;
  if (stdout == null) {
    throw new Error("Linux drop-sudo gate requires a stdout pipe.");
  }
  stdout.setEncoding("utf8");

  await new Promise<void>((resolve, reject) => {
    let buffered = "";
    const cleanup = () => {
      stdout.off("data", onData);
      stdout.off("error", onError);
      stdout.off("end", onEnd);
      child.off("close", onClose);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: string) => {
      buffered += chunk;
      if (buffered.length > 1024) {
        fail(
          new Error("Linux drop-sudo gate emitted an invalid readiness marker.")
        );
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = buffered.slice(0, newline).replace(/\r$/, "");
      if (line !== readyToken) {
        fail(
          new Error("Linux drop-sudo gate did not confirm the clean identity.")
        );
        return;
      }

      const remainder = buffered.slice(newline + 1);
      cleanup();
      if (remainder.length > 0) {
        process.stdout.write(remainder);
      }
      stdout.pipe(process.stdout, { end: false });
      resolve();
    };
    const onError = (error: Error) => fail(error);
    const onEnd = () =>
      fail(new Error("Linux drop-sudo gate exited before becoming ready."));
    const onClose = () =>
      fail(new Error("Linux drop-sudo gate closed before becoming ready."));

    stdout.on("data", onData);
    stdout.once("error", onError);
    stdout.once("end", onEnd);
    child.once("close", onClose);
  });
}

export async function endChildInput(
  child: ChildProcess,
  input: string
): Promise<void> {
  const stdin = child.stdin;
  if (stdin == null) {
    throw new Error("Codex child process does not have a stdin pipe.");
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      stdin.off("finish", onFinish);
      reject(error);
    };
    const onFinish = () => {
      stdin.off("error", onError);
      resolve();
    };
    stdin.once("error", onError);
    stdin.once("finish", onFinish);
    stdin.end(input);
  });
}
