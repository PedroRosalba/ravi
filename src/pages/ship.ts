import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { resolveCallerPath } from "../cli/caller-cwd.js";
import { CloudAuthError } from "../cloud-auth/errors.js";

export type ShipContentKind = "body" | "html" | "dir";

export interface ShipSourceInput {
  body?: string;
  dir?: string;
  entrypoint: string;
  html?: string;
  title: string;
}

export interface ShipSource {
  cleanup?: () => Promise<void>;
  kind: ShipContentKind;
  path: string;
}

export function requireShipTitle(value: string | undefined): string {
  const title = value?.trim();
  if (!title) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Missing --title. ravi pages ship requires a page title.");
  }
  return title;
}

/**
 * Path-shaped label for a page title. This is not a Pages host slug.
 * `pages ship` must not create a `*.ravi.page` host from a title.
 */
export function slugifyPageTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "page";
}

/** `ravi` and `ravi-*` host slugs are reserved and must not be created by the CLI. */
export function isReservedPageHostSlug(slug: string): boolean {
  const normalized = slug.trim().toLowerCase();
  return normalized === "ravi" || normalized.startsWith("ravi-");
}

/**
 * Project-owned default host slug: `<orgSlug>-<projectSlug>`.
 * Returns null when either part is missing, not a DNS label, or a UUID.
 * Callers still reject reserved `ravi` / `ravi-*` results before create.
 */
export function projectOwnedHostSlug(
  orgSlug: string | null | undefined,
  projectSlug: string | null | undefined,
): string | null {
  const org = dnsHostLabel(orgSlug);
  const project = dnsHostLabel(projectSlug);
  if (!org || !project) return null;
  const slug = `${org}-${project}`;
  if (slug.length > 63) return null;
  return slug;
}

export interface ProjectHostCandidate {
  defaultHostname?: unknown;
  hostname?: unknown;
  id?: unknown;
  isDefault?: unknown;
  slug?: unknown;
}

/**
 * Pick the one host a project owns.
 * Prefer `isDefault`. Otherwise match the project-owned slug or its hostname.
 * A title-derived slug is never a match by itself.
 */
export function selectProjectDefaultHost<T extends ProjectHostCandidate>(
  sites: readonly T[],
  conventionSlug: string | null,
): T | null {
  const defaults = sites.filter((site) => site.isDefault === true);
  if (defaults.length > 0) {
    if (conventionSlug) {
      const matched = defaults.find((site) => hostMatchesConvention(site, conventionSlug));
      if (matched) return matched;
    }
    return defaults[0] ?? null;
  }
  if (!conventionSlug) return null;
  return sites.find((site) => hostMatchesConvention(site, conventionSlug)) ?? null;
}

function hostMatchesConvention(site: ProjectHostCandidate, conventionSlug: string): boolean {
  const slug = typeof site.slug === "string" ? site.slug : "";
  const id = typeof site.id === "string" ? site.id : "";
  const hostname =
    (typeof site.defaultHostname === "string" ? site.defaultHostname : "") ||
    (typeof site.hostname === "string" ? site.hostname : "");
  return slug === conventionSlug || id === conventionSlug || hostname === `${conventionSlug}.ravi.page`;
}

function dnsHostLabel(value: string | null | undefined): string | null {
  const slug = value?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(slug)) return null;
  return slug;
}

export function resolveShipContentKind(input: Pick<ShipSourceInput, "body" | "dir" | "html">): ShipContentKind {
  const present = [
    input.body !== undefined ? "body" : null,
    input.html !== undefined ? "html" : null,
    input.dir !== undefined ? "dir" : null,
  ].filter((value): value is ShipContentKind => value !== null);
  if (present.length === 0) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Missing page content. Pass exactly one of --body, --html, or --dir.");
  }
  if (present.length > 1) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "Conflicting page content. Pass exactly one of --body, --html, or --dir.",
    );
  }
  return present[0];
}

export function wrapHtml5Document(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
</head>
<body>
${body.trim()}
</body>
</html>
`;
}

export async function materializeShipSource(input: ShipSourceInput): Promise<ShipSource> {
  const kind = resolveShipContentKind(input);
  if (kind === "dir") {
    const path = requireText(input.dir, "--dir");
    await assertDirectory(path);
    return { kind, path: resolveCallerPath(path) };
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "ravi-pages-ship-"));
  const cleanup = async () => {
    await rm(tempRoot, { recursive: true, force: true });
  };
  try {
    const dest = join(tempRoot, input.entrypoint);
    await mkdir(dirname(dest), { recursive: true });
    if (kind === "body") {
      const body = input.body?.trim();
      if (!body) {
        throw new CloudAuthError("PAYLOAD_INVALID", "Missing --body content. Pass a non-empty HTML fragment.");
      }
      await writeFile(dest, wrapHtml5Document(input.title, body), "utf8");
    } else {
      const htmlPath = requireText(input.html, "--html");
      await assertFile(htmlPath);
      await copyFile(resolveCallerPath(htmlPath), dest);
    }
    return { kind, path: tempRoot, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function validateShipSourceInput(
  input: Pick<ShipSourceInput, "body" | "dir" | "html">,
): Promise<ShipContentKind> {
  const kind = resolveShipContentKind(input);
  if (kind === "body") {
    if (!input.body?.trim()) {
      throw new CloudAuthError("PAYLOAD_INVALID", "Missing --body content. Pass a non-empty HTML fragment.");
    }
    return kind;
  }
  if (kind === "html") {
    await assertFile(requireText(input.html, "--html"));
    return kind;
  }
  await assertDirectory(requireText(input.dir, "--dir"));
  return kind;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function requireText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) throw new CloudAuthError("PAYLOAD_INVALID", `Missing ${label}.`);
  return text;
}

async function assertFile(path: string): Promise<void> {
  const resolved = resolveCallerPath(path);
  const display = displayCallerPath(path);
  try {
    const info = await stat(resolved);
    if (!info.isFile()) {
      throw new CloudAuthError("PAYLOAD_INVALID", `--html must be a file: ${display}`);
    }
  } catch (error) {
    if (error instanceof CloudAuthError) throw error;
    throw new CloudAuthError("PAYLOAD_INVALID", `--html file was not found: ${display}`);
  }
}

async function assertDirectory(path: string): Promise<void> {
  const resolved = resolveCallerPath(path);
  const display = displayCallerPath(path);
  try {
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      throw new CloudAuthError("PAYLOAD_INVALID", `--dir must be a directory: ${display}`);
    }
  } catch (error) {
    if (error instanceof CloudAuthError) throw error;
    throw new CloudAuthError("PAYLOAD_INVALID", `--dir was not found: ${display}`);
  }
}

function displayCallerPath(path: string): string {
  const trimmed = path.trim();
  if (!isAbsolute(trimmed)) return trimmed;
  return basename(trimmed) || "[REDACTED:path]";
}
