/** Safe configuration for official and compatible LLM endpoints. */

export const OFFICIAL_OPENAI_BASE_URL = "https://api.openai.com/v1";

export const LlmApiMode = {
  Responses: "responses",
  ChatCompletions: "chat_completions",
} as const;
export type LlmApiMode = (typeof LlmApiMode)[keyof typeof LlmApiMode];

export type LlmConfigurationErrorKind =
  | "invalid_api_mode"
  | "invalid_site"
  | "missing_base_url"
  | "invalid_base_url"
  | "credentials_in_base_url"
  | "query_or_fragment_in_base_url"
  | "insecure_remote_base_url";

export class LlmConfigurationError extends Error {
  readonly kind: LlmConfigurationErrorKind;

  constructor(kind: LlmConfigurationErrorKind, message: string) {
    super(message);
    this.name = "LlmConfigurationError";
    this.kind = kind;
  }
}

export type LlmEndpointConfig = {
  readonly site: string;
  readonly baseUrl: string;
  readonly apiMode: LlmApiMode;
  readonly isOfficial: boolean;
  readonly requestUrl: string;
};

export function parseLlmApiMode(value?: string | undefined): LlmApiMode {
  const normalized = (value ?? "responses").trim().toLowerCase();
  switch (normalized) {
    case "responses":
    case "response":
      return LlmApiMode.Responses;
    case "chat":
    case "chat_completions":
    case "chat-completions":
      return LlmApiMode.ChatCompletions;
    default:
      throw new LlmConfigurationError(
        "invalid_api_mode",
        "OPENAI_API_MODE must be one of: chat_completions, responses",
      );
  }
}

export function apiModePath(apiMode: LlmApiMode): string {
  return apiMode === LlmApiMode.Responses ? "responses" : "chat/completions";
}

export function resolveLlmEndpoint(input: {
  readonly site?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly apiMode?: string | undefined;
}): LlmEndpointConfig {
  const requestedBaseUrl = normalizedOptional(input.baseUrl);
  const requestedSite = normalizedOptional(input.site);
  const site =
    requestedSite ?? (requestedBaseUrl === undefined ? "official" : "custom");

  if (site.length > 100 || site.includes("\r") || site.includes("\n")) {
    throw new LlmConfigurationError(
      "invalid_site",
      "OPENAI_SITE must be a short single-line name",
    );
  }

  const apiMode = parseLlmApiMode(input.apiMode);
  const isOfficial = site.toLowerCase() === "official";
  const baseUrl = isOfficial
    ? OFFICIAL_OPENAI_BASE_URL
    : normalizeCustomBaseUrl(requestedBaseUrl);

  return {
    site: isOfficial ? "official" : site,
    baseUrl,
    apiMode,
    isOfficial,
    requestUrl: `${baseUrl}/${apiModePath(apiMode)}`,
  };
}

function normalizedOptional(value?: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned === undefined || cleaned === "" ? undefined : cleaned;
}

function normalizeCustomBaseUrl(value: string | undefined): string {
  if (value === undefined) {
    throw new LlmConfigurationError(
      "missing_base_url",
      "OPENAI_BASE_URL is required when OPENAI_SITE is not official",
    );
  }

  const cleaned = value.trim().replace(/\/+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new LlmConfigurationError(
      "invalid_base_url",
      "OPENAI_BASE_URL must be an absolute http(s) URL, usually ending in /v1",
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new LlmConfigurationError(
      "invalid_base_url",
      "OPENAI_BASE_URL must be an absolute http(s) URL, usually ending in /v1",
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new LlmConfigurationError(
      "credentials_in_base_url",
      "OPENAI_BASE_URL must not contain credentials",
    );
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new LlmConfigurationError(
      "query_or_fragment_in_base_url",
      "OPENAI_BASE_URL must not contain query or fragment",
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLocal =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]";
  if (parsed.protocol === "http:" && !isLocal) {
    throw new LlmConfigurationError(
      "insecure_remote_base_url",
      "custom API sites must use HTTPS; HTTP is allowed only for localhost",
    );
  }

  return cleaned;
}
