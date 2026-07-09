const DEFAULT_AUTHAPI_BASE_URL = "https://auth.openai.com/api/accounts";
const WHOAMI_PATH = "/v1/user-auth-credential/whoami";

export type PersonalAccessTokenMetadata = {
  email: string | null;
  chatgptUserId: string;
  chatgptAccountId: string;
  chatgptPlanType: string;
  chatgptAccountIsFedramp: boolean;
};

export async function hydratePersonalAccessToken(
  accessToken: string
): Promise<PersonalAccessTokenMetadata> {
  if (!accessToken.startsWith("at-")) {
    throw new Error(
      "`codex-access-token` must be an `at-...` ChatGPT personal access token. Platform and Azure API keys belong in `openai-api-key`."
    );
  }

  const authapiBaseUrl =
    process.env.CODEX_AUTHAPI_BASE_URL?.trim().replace(/\/+$/, "") ||
    DEFAULT_AUTHAPI_BASE_URL;
  const endpoint = `${authapiBaseUrl}${WHOAMI_PATH}`;
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(
      `Personal access token metadata request failed with status ${response.status}. Check that \`codex-access-token\` is valid and has access to Codex.`
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Personal access token metadata response was not valid JSON.");
  }

  if (!isRecord(body)) {
    throw new Error("Personal access token metadata response was not an object.");
  }

  const email = body.email;
  const chatgptUserId = body.chatgpt_user_id;
  const chatgptAccountId = body.chatgpt_account_id;
  const chatgptPlanType = body.chatgpt_plan_type;
  const chatgptAccountIsFedramp = body.chatgpt_account_is_fedramp;

  if (email !== null && email !== undefined && typeof email !== "string") {
    throw invalidMetadata("email");
  }
  if (typeof chatgptUserId !== "string" || chatgptUserId.length === 0) {
    throw invalidMetadata("chatgpt_user_id");
  }
  if (typeof chatgptAccountId !== "string" || chatgptAccountId.length === 0) {
    throw invalidMetadata("chatgpt_account_id");
  }
  if (typeof chatgptPlanType !== "string" || chatgptPlanType.length === 0) {
    throw invalidMetadata("chatgpt_plan_type");
  }
  if (typeof chatgptAccountIsFedramp !== "boolean") {
    throw invalidMetadata("chatgpt_account_is_fedramp");
  }

  return {
    email: email ?? null,
    chatgptUserId,
    chatgptAccountId,
    chatgptPlanType,
    chatgptAccountIsFedramp,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalidMetadata(field: string): Error {
  return new Error(
    `Personal access token metadata response is missing a valid \`${field}\` field.`
  );
}
