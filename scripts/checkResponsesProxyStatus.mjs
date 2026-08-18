import { appendFileSync, readFileSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { spawnSync } from "node:child_process";

const serverInfoFile = process.argv[2];
if (!serverInfoFile) {
  throw new Error("server info file path is required");
}

const outputFile = process.env.GITHUB_OUTPUT;
if (!outputFile) {
  throw new Error("GITHUB_OUTPUT is required");
}

function setExists(exists) {
  appendFileSync(
    outputFile,
    `server_info_file_exists=${exists ? "true" : "false"}\n`,
    "utf8"
  );
}

function readServerInfo() {
  try {
    if (statSync(serverInfoFile).size === 0) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(serverInfoFile, "utf8"));
    if (
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      !Number.isInteger(parsed.port) ||
      parsed.port <= 0 ||
      parsed.port > 65535
    ) {
      return null;
    }
    return { pid: parsed.pid, port: parsed.port };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this user cannot signal it.
    return error?.code === "EPERM";
  }
}

function portAcceptsConnections(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function removeStaleServerInfo() {
  try {
    rmSync(serverInfoFile, { force: true });
    return;
  } catch (error) {
    if (process.platform === "win32") {
      throw error;
    }
  }

  const result = spawnSync(
    "sudo",
    ["-n", "rm", "-f", "--", serverInfoFile],
    { stdio: "inherit" }
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `stale Responses API proxy server info could not be removed: ${serverInfoFile}`
    );
  }
}

const serverInfo = readServerInfo();
if (serverInfo == null) {
  // Missing and empty files need no cleanup. Malformed non-empty files do.
  try {
    if (statSync(serverInfoFile).size > 0) {
      console.log(`Removing invalid Responses API proxy server info: ${serverInfoFile}`);
      removeStaleServerInfo();
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  setExists(false);
  process.exit(0);
}

const live =
  processExists(serverInfo.pid) &&
  (await portAcceptsConnections(serverInfo.port));

if (live) {
  console.log(
    `Responses API proxy is running (pid ${serverInfo.pid}, port ${serverInfo.port}).`
  );
  setExists(true);
} else {
  console.log(
    `Removing stale Responses API proxy server info (pid ${serverInfo.pid}, port ${serverInfo.port}).`
  );
  removeStaleServerInfo();
  setExists(false);
}
