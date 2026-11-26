/** Security policy for the local-only HTTP boundary. */

import { isIP } from "node:net";

import { HttpBoundaryError } from "./contracts.ts";

export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const SECURITY_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
} as const;

type ParsedAuthority = {
  readonly normalized: string;
  readonly host: string;
  readonly isLoopback: boolean;
  readonly isWildcard: boolean;
};

export class AuthorityPolicy {
  readonly #additionalAuthorities: ReadonlySet<string>;

  constructor(additionalAuthorities: readonly string[] = []) {
    this.#additionalAuthorities = new Set(
      additionalAuthorities.map((authority) => {
        const parsed = parseAuthority(authority);
        if (parsed === undefined || parsed.isWildcard) {
          throw new Error(`invalid allowed HTTP authority: ${authority}`);
        }
        return parsed.normalized;
      }),
    );
  }

  isWellFormedAuthority(authority: string): boolean {
    return parseAuthority(authority) !== undefined;
  }

  allowsAuthority(authority: string): boolean {
    const parsed = parseAuthority(authority);
    return (
      parsed !== undefined &&
      !parsed.isWildcard &&
      (parsed.isLoopback || this.#additionalAuthorities.has(parsed.normalized))
    );
  }

  allowsOrigin(origin: string): boolean {
    const authority = authorityFromOrigin(origin);
    return authority !== undefined && this.allowsAuthority(authority);
  }
}

export function assertSecureRequest(
  request: Request,
  policy: AuthorityPolicy,
): void {
  const host = requiredSingleHeader(request.headers, "Host");
  if (!policy.isWellFormedAuthority(host)) {
    throw new HttpBoundaryError(400, "Host header is malformed");
  }
  if (!policy.allowsAuthority(host)) {
    throw new HttpBoundaryError(403, "host is not allowed");
  }

  if (isStateChanging(request.method)) {
    const origin = optionalSingleHeader(request.headers, "Origin");
    if (origin !== undefined && !policy.allowsOrigin(origin)) {
      throw new HttpBoundaryError(
        403,
        "cross-origin state change is not allowed",
      );
    }
  }

  assertJsonBodyContentType(request.headers, request.body !== null);
}

/** Also used before the Node adapter discards unsupported GET/HEAD bodies. */
export function assertJsonBodyContentType(
  headers: Headers,
  hasBody: boolean,
): void {
  if (hasBody && !isAcceptedJsonContentType(headers)) {
    throw new HttpBoundaryError(
      415,
      "request body must use Content-Type: application/json",
    );
  }
}

export function setSecurityResponseHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(SECURITY_RESPONSE_HEADERS)) {
    headers.set(name, value);
  }
}

function requiredSingleHeader(
  headers: Headers,
  name: "Host" | "Origin",
): string {
  const value = optionalSingleHeader(headers, name);
  if (value === undefined) {
    throw new HttpBoundaryError(400, `HTTP/1.1 requires a ${name} header`);
  }
  return value;
}

function optionalSingleHeader(
  headers: Headers,
  name: "Host" | "Origin",
): string | undefined {
  const value = headers.get(name);
  if (value === null) return undefined;
  if (value.includes(",")) {
    throw new HttpBoundaryError(
      400,
      `multiple ${name} headers are not allowed`,
    );
  }
  return value;
}

function isStateChanging(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD";
}

function isAcceptedJsonContentType(headers: Headers): boolean {
  const value = headers.get("Content-Type");
  if (value === null || value.includes(",")) return false;
  const parts = value
    .split(";")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== "");
  return (
    (parts.length === 1 ||
      (parts.length === 2 && parts[1] === "charset=utf-8")) &&
    parts[0] === "application/json"
  );
}

function authorityFromOrigin(origin: string): string | undefined {
  if (origin !== origin.trim() || origin === "null" || origin.includes(",")) {
    return undefined;
  }
  const match = /^(?:http|https):\/\/([^/?#]+)$/iu.exec(origin);
  if (match === null) return undefined;
  const authority = match[1];
  return authority === undefined ? undefined : authority;
}

function parseAuthority(authority: string): ParsedAuthority | undefined {
  if (
    authority === "" ||
    authority !== authority.trim() ||
    /[\s,@/\\?#%]/u.test(authority)
  ) {
    return undefined;
  }

  let host: string;
  let port: string | undefined;
  if (authority.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::([0-9]+))?$/u.exec(authority);
    if (match === null || match[1] === undefined || isIP(match[1]) !== 6) {
      return undefined;
    }
    host = `[${match[1].toLowerCase()}]`;
    port = match[2];
  } else if (authority === "::1") {
    host = authority;
  } else {
    const separatorCount = authority.split(":").length - 1;
    if (separatorCount > 1) return undefined;
    if (separatorCount === 1) {
      const separator = authority.lastIndexOf(":");
      host = authority.slice(0, separator);
      port = authority.slice(separator + 1);
    } else {
      host = authority;
    }
    host = host.toLowerCase();
  }

  if (host === "" || !validHost(host) || !validPort(port)) return undefined;

  const normalized = port === undefined ? host : `${host}:${Number(port)}`;
  const unwrappedHost = host.startsWith("[") ? host.slice(1, -1) : host;
  const ipv4 = isIP(unwrappedHost) === 4 ? unwrappedHost.split(".") : undefined;
  return {
    normalized,
    host: unwrappedHost,
    isLoopback:
      unwrappedHost === "localhost" ||
      unwrappedHost === "::1" ||
      ipv4?.[0] === "127",
    isWildcard: unwrappedHost === "0.0.0.0" || unwrappedHost === "::",
  };
}

function validHost(host: string): boolean {
  const unwrapped = host.startsWith("[") ? host.slice(1, -1) : host;
  if (isIP(unwrapped) !== 0) return true;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u.test(
    unwrapped,
  );
}

function validPort(port: string | undefined): boolean {
  if (port === undefined) return true;
  if (!/^[0-9]+$/u.test(port)) return false;
  const value = Number(port);
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}
