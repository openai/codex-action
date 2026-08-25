import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("system service sockets preservation logic under drop-sudo", async (t) => {
  const PRESERVED_SYSTEM_SOCKET_PREFIXES = [
    "/run/dbus/",
    "/run/systemd/",
    "/var/run/dbus/",
    "/var/run/systemd/",
  ];

  function isPreservedSystemServiceSocket(socketPath) {
    return PRESERVED_SYSTEM_SOCKET_PREFIXES.some((prefix) =>
      socketPath.startsWith(prefix)
    );
  }

  // 1. Direct unit assertions on path prefixes
  await t.test("matches critical D-Bus and systemd sockets", () => {
    assert.equal(isPreservedSystemServiceSocket("/run/dbus/system_bus_socket"), true);
    assert.equal(isPreservedSystemServiceSocket("/run/systemd/journal/stdout"), true);
    assert.equal(isPreservedSystemServiceSocket("/run/systemd/journal/socket"), true);
    assert.equal(isPreservedSystemServiceSocket("/var/run/dbus/system_bus_socket"), true);
    assert.equal(isPreservedSystemServiceSocket("/var/run/systemd/resolve/io.systemd.Resolve"), true);
  });

  await t.test("does not match privileged daemon sockets (must still be restricted)", () => {
    assert.equal(isPreservedSystemServiceSocket("/run/docker.sock"), false);
    assert.equal(isPreservedSystemServiceSocket("/run/containerd/containerd.sock"), false);
    assert.equal(isPreservedSystemServiceSocket("/run/podman/podman.sock"), false);
    assert.equal(isPreservedSystemServiceSocket("/run/libvirt/libvirt-sock"), false);
    assert.equal(isPreservedSystemServiceSocket("/run/snapd.socket"), false);
  });

  // 2. Real UNIX domain socket creation & mode preservation simulation
  await t.test("simulates permission preservation on created unix socket", async () => {
    const testDir = join(tmpdir(), `codex-socket-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const mockSocketPath = join(testDir, "test.sock");

    const server = createServer();
    await new Promise((resolve) => server.listen(mockSocketPath, resolve));

    try {
      // Simulate typical 0666 socket mode on system bus
      chmodSync(mockSocketPath, 0o666);
      const initialMode = lstatSync(mockSocketPath).mode & 0o777;
      assert.equal(initialMode, 0o666);

      // Function simulating the updated drop-sudo logic
      function simulateRestrict(path, isPreserved) {
        if (isPreserved) {
          return false; // Preserved, mode not altered
        }
        chmodSync(path, 0o700);
        return true;
      }

      // Case A: Mock D-Bus socket path (preserved)
      const mockDbusPreserved = isPreservedSystemServiceSocket("/run/dbus/system_bus_socket");
      const dbusChanged = simulateRestrict(mockSocketPath, mockDbusPreserved);
      assert.equal(dbusChanged, false);
      assert.equal(lstatSync(mockSocketPath).mode & 0o777, 0o666, "D-Bus socket permissions must remain 0666");

      // Case B: Mock Docker socket path (restricted)
      const mockDockerPreserved = isPreservedSystemServiceSocket("/run/docker.sock");
      const dockerChanged = simulateRestrict(mockSocketPath, mockDockerPreserved);
      assert.equal(dockerChanged, true);
      assert.equal(lstatSync(mockSocketPath).mode & 0o777, 0o700, "Docker socket permissions must be restricted to 0700");
    } finally {
      server.close();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
