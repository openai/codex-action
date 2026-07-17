import { randomBytes } from "node:crypto";
import { type ChildProcess } from "node:child_process";

const ENV_PATH = "/usr/bin/env";
const SETPRIV_PATH = "/usr/bin/setpriv";
const SHELL_PATH = "/bin/sh";
const SUDO_PATH = "/usr/bin/sudo";

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

/** Builds a Codex command that waits after entering the reduced Linux identity. */
export function buildGatedCodexCommand({
  uid,
  gid,
  user,
  home,
  codexPath,
  codexArgs,
}: {
  uid: number;
  gid: number;
  user: string;
  home: string;
  codexPath: string;
  codexArgs: Array<string>;
}): GatedCodexCommand {
  const readyToken = `codex-action-ready-${randomBytes(16).toString("hex")}`;
  const goToken = `codex-action-go-${randomBytes(16).toString("hex")}`;

  return {
    program: SUDO_PATH,
    args: [
      "-n",
      "-E",
      "--",
      SETPRIV_PATH,
      `--reuid=${uid}`,
      `--regid=${gid}`,
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
      "ENV",
      "-u",
      "BASH_ENV",
      "-u",
      "SHELLOPTS",
      `HOME=${home}`,
      `USER=${user}`,
      `LOGNAME=${user}`,
      `PATH=${process.env.PATH ?? ""}`,
      SHELL_PATH,
      "-c",
      GATE_SCRIPT,
      "codex-action-gate",
      readyToken,
      goToken,
      codexPath,
      ...codexArgs,
    ],
    readyToken,
    goToken,
  };
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
          new Error("Linux drop-sudo gate did not confirm the reduced identity.")
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
