const value = (name) => (process.env[name] ?? "").trim();

const prompt = value("CODEX_PROMPT");
const promptFile = value("CODEX_PROMPT_FILE");
const outputSchema = value("CODEX_OUTPUT_SCHEMA");
const outputSchemaFile = value("CODEX_OUTPUT_SCHEMA_FILE");
const sandbox = value("CODEX_SANDBOX");
const permissionProfile = value("CODEX_PERMISSION_PROFILE");
const safetyStrategy = value("CODEX_SAFETY_STRATEGY");

if (prompt && promptFile) {
  throw new Error("Only one of `prompt` or `prompt-file` may be specified.");
}

if (outputSchema && outputSchemaFile) {
  throw new Error(
    "Only one of `output-schema` or `output-schema-file` may be specified."
  );
}

if (permissionProfile && sandbox) {
  throw new Error(
    "`permission-profile` and `sandbox` are mutually exclusive. Permission profiles do not compose with legacy sandbox settings."
  );
}

if (permissionProfile && safetyStrategy === "read-only") {
  throw new Error(
    "`permission-profile` cannot be combined with the `read-only` safety strategy because that strategy forces the legacy read-only sandbox."
  );
}
