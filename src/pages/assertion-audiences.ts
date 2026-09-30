import { stripVTControlCharacters } from "node:util";
import { looksLikeProviderDump } from "../cli/payload-error-message.js";
import { normalizeConsoleUrl } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { createAuthenticatedPagesContext, type PagesClientDeps, type PagesClientOptions } from "./client.js";

/**
 * Console contract from ravi-console#31
 * (`.ravi/specs/console/pages/viewer-assertions/cli/SPEC.md`).
 * `siteRef` is the path segment and accepts a host slug, site id, or hostname.
 */
export const PAGE_ASSERTION_AUDIENCES_COLLECTION = "viewer-assertion-audiences";

/** Capability id a shipped page must list to receive the viewer assertion. */
export const RAVI_IDENTITY_ASSERTION_USE = "ravi.identity.assertion";

export const PAGES_ASSERTION_JWKS_PATH = "/api/public/pages/viewer-assertions/jwks";
export const PAGE_ASSERTION_AUDIENCE_ORIGIN_LIMIT = 8;

const AUDIENCE_USE_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface PageAssertionAudience {
  aud: string;
  origins: string[];
}

export interface PageAssertionAudienceListOptions extends PagesClientOptions {
  project: string;
  site: string;
}

export interface PageAssertionAudienceSetOptions extends PageAssertionAudienceListOptions {
  aud: string;
  origins: string[];
}

export interface PageAssertionAudienceRemoveOptions extends PageAssertionAudienceListOptions {
  aud: string;
}

export interface PageAssertionAudienceListResult {
  audiences: PageAssertionAudience[];
  consoleUrl: string;
  jwksUrl: string;
  projectRef: string;
  siteRef: string;
  success: true;
  total: number;
}

export interface PageAssertionAudienceMutationResult {
  action: "remove" | "set";
  aud: string;
  audiences: PageAssertionAudience[];
  consoleUrl: string;
  jwksUrl: string;
  origins: string[];
  projectRef: string;
  siteRef: string;
  success: true;
}

export function pageAssertionAudiencesPath(project: string, site: string): string {
  return `/api/cli/projects/${encodeURIComponent(project)}/pages/${encodeURIComponent(site)}/${PAGE_ASSERTION_AUDIENCES_COLLECTION}`;
}

export function pagesAssertionJwksUrl(consoleUrl: string): string {
  return new URL(PAGES_ASSERTION_JWKS_PATH, `${normalizeConsoleUrl(consoleUrl)}/`).toString();
}

export function normalizeAssertionAud(value: string | undefined): string {
  const aud = value?.trim() ?? "";
  if (!aud) throw new CloudAuthError("PAYLOAD_INVALID", "Missing --aud.");
  if (aud.length > 200 || /\s/.test(aud)) {
    throw new CloudAuthError("PAYLOAD_INVALID", "--aud must be a single audience identifier without whitespace.");
  }
  if (looksLikeJwt(aud)) {
    throw new CloudAuthError("PAYLOAD_INVALID", "--aud must be an audience identifier. Do not pass a JWT.");
  }
  return aud;
}

export function normalizeAssertionOrigins(values: readonly string[] | string | undefined): string[] {
  const raw = Array.isArray(values) ? values : values ? [values] : [];
  const parts = raw
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "Missing --origin. Pass one or more https origins of this Pages site (the default host or an active custom hostname).",
    );
  }
  const origins = [...new Set(parts.map(normalizeHttpsOrigin))];
  if (origins.length > PAGE_ASSERTION_AUDIENCE_ORIGIN_LIMIT) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      `Set at most ${PAGE_ASSERTION_AUDIENCE_ORIGIN_LIMIT} origins on one audience.`,
    );
  }
  return origins;
}

export function normalizePageUses(values: readonly string[] | string | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  const raw = Array.isArray(values) ? values : [values];
  const parts = raw
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  const uses: string[] = [];
  for (const part of parts) {
    if (part.length > 80 || !AUDIENCE_USE_PATTERN.test(part)) {
      throw new CloudAuthError(
        "PAYLOAD_INVALID",
        `Invalid --uses value "${part}". Use ids such as ${RAVI_IDENTITY_ASSERTION_USE}.`,
      );
    }
    if (!uses.includes(part)) uses.push(part);
  }
  return uses;
}

const PAGES_HOST_ORIGIN_RULE =
  "--origin must be an https origin of this Pages site (the default host or an active custom hostname). Put the API identifier in --aud.";

const PAGES_HOST_ORIGIN_ACTION =
  "Pass --origin as an https origin of this Pages site, such as https://<site>.ravi.page or an active custom hostname. Put the API identifier in --aud.";

const GENERIC_PAYLOAD_ACTION = "correct the command input and retry";

const GENERIC_CONSOLE_PAYLOAD_MESSAGES = new Set([
  "console request failed.",
  "console request input was invalid.",
  "cloud service request failed.",
]);

export interface AssertionAudienceSetRejection {
  message: string;
  suggestedAction: string;
  issues?: CloudAuthError["issues"];
}

/**
 * Console HTTP 400 on `assertion audiences set`. The hostname allowlist stays
 * in Console. Forward a safe Console sentence when one exists. When the body
 * is empty or unsafe, state that `--origin` must be this site's Pages host.
 */
export function describeAssertionAudienceSetRejection(error: unknown): AssertionAudienceSetRejection | null {
  if (!(error instanceof CloudAuthError)) return null;
  if (error.code !== "PAYLOAD_INVALID" || error.status !== 400) return null;
  const detail = safeConsoleDetail(error.message) ?? firstSafeIssueDetail(error.issues);
  const issues = scrubbedIssues(error.issues);
  const aboutPagesHost = detail !== undefined && mentionsPagesHostOrigin(detail);
  if (detail && !aboutPagesHost) {
    return {
      message: detail,
      suggestedAction: GENERIC_PAYLOAD_ACTION,
      ...(issues ? { issues } : {}),
    };
  }
  return {
    message: detail ? `${PAGES_HOST_ORIGIN_RULE} Console: ${detail}` : PAGES_HOST_ORIGIN_RULE,
    suggestedAction: PAGES_HOST_ORIGIN_ACTION,
    ...(issues ? { issues } : {}),
  };
}

export async function listPageAssertionAudiences(
  options: PageAssertionAudienceListOptions,
  deps: PagesClientDeps = {},
): Promise<PageAssertionAudienceListResult> {
  const project = requireText(options.project, "project");
  const site = requireText(options.site, "site");
  const auth = await createAuthenticatedPagesContext(options, deps);
  const payload = await auth.client.requestJson<unknown>(
    "GET",
    pageAssertionAudiencesPath(project, site),
    undefined,
    auth.accessToken,
  );
  const audiences = readAudiences(payload);
  return {
    audiences,
    consoleUrl: auth.consoleUrl,
    jwksUrl: resolveJwksUrl(auth.consoleUrl, payload),
    projectRef: project,
    siteRef: readSiteRef(payload) ?? site,
    success: true,
    total: audiences.length,
  };
}

export async function setPageAssertionAudience(
  options: PageAssertionAudienceSetOptions,
  deps: PagesClientDeps = {},
): Promise<PageAssertionAudienceMutationResult> {
  return mutatePageAssertionAudience("set", "PUT", options, deps);
}

export async function removePageAssertionAudience(
  options: PageAssertionAudienceRemoveOptions,
  deps: PagesClientDeps = {},
): Promise<PageAssertionAudienceMutationResult> {
  return mutatePageAssertionAudience("remove", "DELETE", options, deps);
}

async function mutatePageAssertionAudience(
  action: "remove" | "set",
  method: "DELETE" | "PUT",
  options: PageAssertionAudienceSetOptions | PageAssertionAudienceRemoveOptions,
  deps: PagesClientDeps,
): Promise<PageAssertionAudienceMutationResult> {
  const project = requireText(options.project, "project");
  const site = requireText(options.site, "site");
  const aud = options.aud;
  const origins = "origins" in options ? options.origins : [];
  const auth = await createAuthenticatedPagesContext(options, deps);
  const payload = await auth.client.requestJson<unknown>(
    method,
    pageAssertionAudiencesPath(project, site),
    {
      aud,
      ...(action === "set" ? { origins } : {}),
    },
    auth.accessToken,
  );
  const audiences = readAudiences(payload);
  const matched = audiences.find((audience) => audience.aud === aud);
  return {
    action,
    aud,
    audiences,
    consoleUrl: auth.consoleUrl,
    jwksUrl: resolveJwksUrl(auth.consoleUrl, payload),
    origins: matched?.origins ?? (action === "set" ? origins : []),
    projectRef: project,
    siteRef: readSiteRef(payload) ?? site,
    success: true,
  };
}

function normalizeHttpsOrigin(value: string): string {
  if (looksLikeJwt(value)) {
    throw new CloudAuthError("PAYLOAD_INVALID", "--origin must be an https origin. Do not pass a JWT.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CloudAuthError("PAYLOAD_INVALID", `--origin must be an https origin. Received "${value}".`);
  }
  if (parsed.protocol !== "https:") {
    throw new CloudAuthError("PAYLOAD_INVALID", `--origin must use https. Received "${value}".`);
  }
  if (parsed.username || parsed.password) {
    throw new CloudAuthError("PAYLOAD_INVALID", "--origin must not include userinfo.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      `--origin must be an origin (scheme, host, optional port), not a URL path. Received "${value}".`,
    );
  }
  return parsed.origin;
}

function readAudiences(payload: unknown): PageAssertionAudience[] {
  const record = objectValue(payload);
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.audiences)
      ? record.audiences
      : Array.isArray(record?.items)
        ? record.items
        : record?.audience || record?.aud
          ? [record]
          : [];
  const audiences: PageAssertionAudience[] = [];
  for (const item of source) {
    const audience = readAudience(item);
    if (!audience) continue;
    const existing = audiences.find((candidate) => candidate.aud === audience.aud);
    if (existing) {
      existing.origins = [...new Set([...existing.origins, ...audience.origins])];
      continue;
    }
    audiences.push(audience);
  }
  return audiences;
}

function readAudience(payload: unknown): PageAssertionAudience | null {
  const record = objectValue(payload);
  if (!record) return null;
  const aud = readAudienceId(record);
  if (!aud || looksLikeJwt(aud) || /\s/.test(aud)) return null;
  const rawOrigins = Array.isArray(record?.origins) ? record.origins : [];
  const origins: string[] = [];
  for (const value of rawOrigins) {
    if (typeof value !== "string" || looksLikeJwt(value)) continue;
    try {
      const origin = normalizeHttpsOrigin(value);
      if (!origins.includes(origin)) origins.push(origin);
    } catch {}
  }
  return { aud, origins };
}

function resolveJwksUrl(consoleUrl: string, payload: unknown): string {
  const derived = pagesAssertionJwksUrl(consoleUrl);
  const record = objectValue(payload);
  const candidate = typeof record?.jwksUrl === "string" ? record.jwksUrl : "";
  if (!candidate || looksLikeJwt(candidate)) return derived;
  try {
    const parsed = new URL(candidate);
    const consoleOrigin = new URL(normalizeConsoleUrl(consoleUrl)).origin;
    if (
      parsed.origin === consoleOrigin &&
      parsed.pathname === PAGES_ASSERTION_JWKS_PATH &&
      !parsed.search &&
      !parsed.hash
    ) {
      return parsed.toString();
    }
  } catch {
    return derived;
  }
  return derived;
}

/** Console responses use `audience`. `aud` remains a response alias. Prefer `audience`. */
function readAudienceId(record: Record<string, unknown>): string {
  const audience = typeof record.audience === "string" ? record.audience.trim() : "";
  if (audience) return audience;
  return typeof record.aud === "string" ? record.aud.trim() : "";
}

function readSiteRef(payload: unknown): string | null {
  const record = objectValue(payload);
  const siteRef = record?.siteRef;
  return typeof siteRef === "string" && siteRef.trim() && !looksLikeJwt(siteRef) ? siteRef.trim() : null;
}

function looksLikeJwt(value: string): boolean {
  return JWT_PATTERN.test(value.trim());
}

function requireText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) throw new CloudAuthError("PAYLOAD_INVALID", `Missing ${label}.`);
  return text;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function safeConsoleDetail(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const cleaned = stripVTControlCharacters(message)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length > 1024) return undefined;
  if (looksLikeProviderDump(cleaned)) return undefined;
  const scrubbed = scrubCredentialUrls(cleaned);
  if (!scrubbed || scrubbed.length < 8 || looksLikeProviderDump(scrubbed)) return undefined;
  if (GENERIC_CONSOLE_PAYLOAD_MESSAGES.has(scrubbed.toLowerCase())) return undefined;
  return scrubbed.length > 400 ? `${scrubbed.slice(0, 397)}...` : scrubbed;
}

function scrubCredentialUrls(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)]+/gi, (url) => {
      try {
        return new URL(url).origin;
      } catch {
        return "";
      }
    })
    .replace(/\s+/g, " ")
    .trim();
}

function mentionsPagesHostOrigin(detail: string): boolean {
  return /\b(hostname|origins?|ravi\.page)\b/i.test(detail);
}

function firstSafeIssueDetail(issues: CloudAuthError["issues"]): string | undefined {
  if (!issues) return undefined;
  for (const issue of issues) {
    const detail = safeConsoleDetail(issue.message);
    if (detail) return detail;
  }
  return undefined;
}

function scrubbedIssues(issues: CloudAuthError["issues"]): CloudAuthError["issues"] {
  if (!issues || issues.length === 0) return undefined;
  const next = issues.flatMap((issue) => {
    const message = safeConsoleDetail(issue.message);
    if (!message) return [];
    return [{ ...issue, message }];
  });
  return next.length > 0 ? next : undefined;
}
