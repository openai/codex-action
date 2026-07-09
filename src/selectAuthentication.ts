export type AuthenticationMode =
  | "none"
  | "openai-api-key"
  | "codex-access-token";

export function selectAuthentication({
  hasOpenaiApiKey,
  hasCodexAccessToken,
  hasResponsesApiEndpoint,
}: {
  hasOpenaiApiKey: boolean;
  hasCodexAccessToken: boolean;
  hasResponsesApiEndpoint: boolean;
}): AuthenticationMode {
  if (hasOpenaiApiKey && hasCodexAccessToken) {
    throw new Error(
      "`openai-api-key` and `codex-access-token` are mutually exclusive. Put a Platform or Azure key in `openai-api-key`, or put an `at-...` ChatGPT personal access token in `codex-access-token`."
    );
  }

  if (hasCodexAccessToken && hasResponsesApiEndpoint) {
    throw new Error(
      "`responses-api-endpoint` cannot be combined with `codex-access-token`. ChatGPT personal access tokens use the ChatGPT Codex endpoint; use `openai-api-key` for a custom Responses endpoint."
    );
  }

  if (hasOpenaiApiKey) {
    return "openai-api-key";
  }
  if (hasCodexAccessToken) {
    return "codex-access-token";
  }
  return "none";
}
