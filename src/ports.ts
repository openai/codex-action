const MIN_PORT = 1;
const MAX_PORT = 65535;

export function isValidPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_PORT &&
    value <= MAX_PORT
  );
}

export function parsePort(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw invalidPortError(value);
  }

  const port = Number.parseInt(trimmed, 10);
  if (!isValidPort(port)) {
    throw invalidPortError(value);
  }

  return port;
}

export function ensureValidPort(value: unknown): number {
  if (!isValidPort(value)) {
    throw invalidPortError(formatPortValue(value));
  }

  return value;
}

function invalidPortError(value: string): Error {
  return new Error(
    `Invalid port: ${value}. Expected an integer between ${MIN_PORT} and ${MAX_PORT}.`
  );
}

function formatPortValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value === undefined) {
    return "undefined";
  }
  return String(value);
}