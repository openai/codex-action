export interface LinuxRunnerCredentials {
  userId: number;
  primaryGroupId: number;
  supplementaryGroupIds: Array<number>;
}

function validId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < 0xffffffff
  );
}

export function parseLinuxRunnerCredentials(
  value: string
): LinuxRunnerCredentials {
  const parsed: unknown = JSON.parse(value);
  if (parsed == null || typeof parsed !== "object") {
    throw new Error("Invalid original Linux runner credentials.");
  }
  const credentials = parsed as Partial<LinuxRunnerCredentials>;
  if (
    !validId(credentials.userId) ||
    credentials.userId === 0 ||
    !validId(credentials.primaryGroupId) ||
    !Array.isArray(credentials.supplementaryGroupIds) ||
    credentials.supplementaryGroupIds.length > 65536 ||
    !credentials.supplementaryGroupIds.every(validId)
  ) {
    throw new Error("Invalid original Linux runner credentials.");
  }
  return {
    userId: credentials.userId,
    primaryGroupId: credentials.primaryGroupId,
    supplementaryGroupIds: [...new Set(credentials.supplementaryGroupIds)],
  };
}

export function captureLinuxRunnerCredentials(): LinuxRunnerCredentials {
  const userId = process.getuid?.();
  const primaryGroupId = process.getgid?.();
  const supplementaryGroupIds = process.getgroups?.();
  if (
    userId == null ||
    userId === 0 ||
    primaryGroupId == null ||
    supplementaryGroupIds == null
  ) {
    throw new Error("Linux drop-sudo requires a non-root runner user.");
  }
  return { userId, primaryGroupId, supplementaryGroupIds };
}

export function includeAccountGroups(
  original: LinuxRunnerCredentials,
  accountUserId: number,
  accountGroupIds: Array<number>
): LinuxRunnerCredentials {
  if (original.userId !== accountUserId) {
    throw new Error(
      "Original runner UID does not match the account being restricted."
    );
  }
  // Checking the union is conservative: it covers both existing processes and
  // fresh processes whose groups come from the current account database.
  return {
    ...original,
    supplementaryGroupIds: [
      ...new Set([...original.supplementaryGroupIds, ...accountGroupIds]),
    ].filter((id) => id !== original.primaryGroupId),
  };
}
