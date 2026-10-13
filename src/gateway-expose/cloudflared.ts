// Pinned cloudflared: download, verify, install and locate. The tunnel runner
// (`ravi gateway tunnel-run`) only ever starts the binary this module put in
// `~/.ravi/bin/cloudflared-<version>`, or one the operator named explicitly
// (reported `verified: false`). Normative: `.ravi/specs/sandbox/tunnel-runner`.
//
// The download is checked against the SHA-256 recorded here BEFORE anything
// is extracted, in a fresh directory that is removed on every outcome; the
// binary is only renamed into place after its `--version` matched the pin, so
// a failed install leaves nothing behind. Redirects are followed by hand and
// only to the GitHub release hosts.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { getRaviStateDir } from "../utils/paths.js";

/**
 * The pinned release. Hashes copied on 2026-10-13 from the GitHub release API
 * (`api.github.com/repos/cloudflare/cloudflared/releases`, asset `digest`);
 * the Linux values also equal the release notes' "SHA256 Checksums". The
 * darwin `.tgz` values in the release notes differ from the served bytes for
 * every recent release; see the spec RUNBOOK §Pinned release.
 */
export const CLOUDFLARED_VERSION = "2026.9.1";

export type CloudflaredPlatformKey = "darwin-arm64" | "darwin-amd64" | "linux-amd64" | "linux-arm64";

export interface CloudflaredAsset {
  url: string;
  sha256: string;
  /** `tgz`: a gzip tar holding `cloudflared`; `binary`: the executable itself. */
  archive: "tgz" | "binary";
}

const RELEASE_BASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;

export const CLOUDFLARED_ASSETS: Readonly<Record<CloudflaredPlatformKey, CloudflaredAsset>> = Object.freeze({
  "darwin-arm64": {
    url: `${RELEASE_BASE}/cloudflared-darwin-arm64.tgz`,
    sha256: "c27ab8fd0aa489449e3d201eb02f957ef460a13b613662928b1b23394bf1bcfe",
    archive: "tgz",
  },
  "darwin-amd64": {
    url: `${RELEASE_BASE}/cloudflared-darwin-amd64.tgz`,
    sha256: "ff0d3b51d5ff70eceef89d6b32145fee985018a2174596a5dbe405e2766e2ac4",
    archive: "tgz",
  },
  "linux-amd64": {
    url: `${RELEASE_BASE}/cloudflared-linux-amd64`,
    sha256: "03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc",
    archive: "binary",
  },
  "linux-arm64": {
    url: `${RELEASE_BASE}/cloudflared-linux-arm64`,
    sha256: "3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3",
    archive: "binary",
  },
});

/** Hosts a release download may be served from; any other redirect target is refused. */
export const CLOUDFLARED_DOWNLOAD_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
export const CLOUDFLARED_MAX_DOWNLOAD_BYTES = 96 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const INSTALL_MODE = 0o700;

export type CloudflaredInstallErrorCode =
  | "unsupported_platform"
  | "download_failed"
  | "redirect_refused"
  | "too_large"
  | "checksum_mismatch"
  | "archive_invalid"
  | "version_mismatch"
  | "not_found";

export class CloudflaredInstallError extends Error {
  constructor(
    readonly code: CloudflaredInstallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CloudflaredInstallError";
  }
}

export function cloudflaredPlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): CloudflaredPlatformKey {
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if ((platform === "darwin" || platform === "linux") && cpu) return `${platform}-${cpu}`;
  throw new CloudflaredInstallError(
    "unsupported_platform",
    `No pinned cloudflared ${CLOUDFLARED_VERSION} build for ${platform}-${arch}; supported: ${Object.keys(CLOUDFLARED_ASSETS).join(", ")}. Pass --cloudflared <path> to use your own (unverified).`,
  );
}

export function cloudflaredBinDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "bin");
}

export function pinnedCloudflaredPath(binDir: string = cloudflaredBinDir()): string {
  return join(binDir, `cloudflared-${CLOUDFLARED_VERSION}`);
}

export interface CommandOutput {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type CloudflaredFetch = (url: string, init: { redirect: "manual"; signal?: AbortSignal }) => Promise<Response>;

export interface InstallCloudflaredDeps {
  fetch?: CloudflaredFetch;
  platform?: NodeJS.Platform;
  arch?: string;
  binDir?: string;
  /** Runs `<path> --version`; tests inject it. */
  runVersion?: (path: string) => CommandOutput;
  /** Tests only: assets whose bytes they can produce. */
  assets?: Readonly<Record<CloudflaredPlatformKey, CloudflaredAsset>>;
}

export interface InstalledCloudflared {
  path: string;
  version: string;
  platform: CloudflaredPlatformKey;
  sha256: string;
  /** True when the pinned binary was already installed and passed the version check. */
  reused: boolean;
}

export async function installCloudflared(deps: InstallCloudflaredDeps = {}): Promise<InstalledCloudflared> {
  const key = cloudflaredPlatformKey(deps.platform, deps.arch);
  const asset = (deps.assets ?? CLOUDFLARED_ASSETS)[key];
  const binDir = deps.binDir ?? cloudflaredBinDir();
  const target = pinnedCloudflaredPath(binDir);
  const runVersion = deps.runVersion ?? defaultRunVersion;

  if (isPrivateRegularFile(target) && versionMatches(runVersion(target))) {
    return { path: target, version: CLOUDFLARED_VERSION, platform: key, sha256: asset.sha256, reused: true };
  }

  mkdirSync(binDir, { recursive: true, mode: INSTALL_MODE });
  chmodSync(binDir, INSTALL_MODE);
  const workDir = mkdtempSync(join(binDir, ".cloudflared-install-"));
  try {
    chmodSync(workDir, INSTALL_MODE);
    const downloaded = await download(asset.url, deps.fetch ?? (globalThis.fetch as CloudflaredFetch));
    const actual = createHash("sha256").update(downloaded).digest("hex");
    if (actual !== asset.sha256) {
      throw new CloudflaredInstallError(
        "checksum_mismatch",
        `cloudflared ${CLOUDFLARED_VERSION} (${key}) checksum mismatch: expected ${asset.sha256}, got ${actual}. Nothing was installed.`,
      );
    }
    const binary = asset.archive === "tgz" ? extractCloudflaredFromTgz(downloaded) : downloaded;
    const staged = join(workDir, "cloudflared");
    writeFileSync(staged, binary, { mode: INSTALL_MODE });
    chmodSync(staged, INSTALL_MODE);
    const output = runVersion(staged);
    if (!versionMatches(output)) {
      throw new CloudflaredInstallError(
        "version_mismatch",
        `The downloaded cloudflared did not report version ${CLOUDFLARED_VERSION} (exit ${output.status}). Nothing was installed.`,
      );
    }
    renameSync(staged, target);
    chmodSync(target, INSTALL_MODE);
    return { path: target, version: CLOUDFLARED_VERSION, platform: key, sha256: asset.sha256, reused: false };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export type LocatedCloudflared =
  | { found: true; path: string; verified: true; source: "pinned"; version: string }
  | { found: true; path: string; verified: false; source: "explicit"; version: null }
  | { found: false; reason: "not_installed" | "explicit_invalid"; path: string };

/** The pinned install when present and private to this user; an explicit path is accepted but never verified. */
export function locateCloudflared(options: { explicitPath?: string; binDir?: string } = {}): LocatedCloudflared {
  const explicit = options.explicitPath?.trim();
  if (explicit) {
    if (!isAbsolute(explicit) || !isExecutableFile(explicit)) {
      return { found: false, reason: "explicit_invalid", path: explicit };
    }
    return { found: true, path: explicit, verified: false, source: "explicit", version: null };
  }
  const pinned = pinnedCloudflaredPath(options.binDir ?? cloudflaredBinDir());
  if (!isPrivateRegularFile(pinned)) return { found: false, reason: "not_installed", path: pinned };
  return { found: true, path: pinned, verified: true, source: "pinned", version: CLOUDFLARED_VERSION };
}

export function versionMatches(output: CommandOutput): boolean {
  return (
    output.status === 0 && new RegExp(`\\bversion ${CLOUDFLARED_VERSION.replace(/\./g, "\\.")}\\b`).test(output.stdout)
  );
}

async function download(url: string, fetchImpl: CloudflaredFetch): Promise<Uint8Array> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertDownloadUrl(current);
    let response: Response;
    try {
      response = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
    } catch (error) {
      throw new CloudflaredInstallError(
        "download_failed",
        `cloudflared download failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location)
        throw new CloudflaredInstallError("download_failed", "cloudflared download redirect without Location");
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok || !response.body) {
      throw new CloudflaredInstallError("download_failed", `cloudflared download failed: HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > CLOUDFLARED_MAX_DOWNLOAD_BYTES) throw tooLarge();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > CLOUDFLARED_MAX_DOWNLOAD_BYTES) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  throw new CloudflaredInstallError("download_failed", "cloudflared download: too many redirects");
}

function assertDownloadUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CloudflaredInstallError("redirect_refused", "cloudflared download URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || !CLOUDFLARED_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new CloudflaredInstallError(
      "redirect_refused",
      `cloudflared download refused: ${url.protocol}//${url.hostname} is not a GitHub release host`,
    );
  }
}

const tooLarge = () =>
  new CloudflaredInstallError("too_large", `cloudflared download exceeds ${CLOUDFLARED_MAX_DOWNLOAD_BYTES} bytes`);

const TAR_MEMBER_NAMES = new Set(["cloudflared", "./cloudflared"]);

/** Reads the `cloudflared` regular-file member from a gzip tar; no other entry is ever written to disk. */
export function extractCloudflaredFromTgz(archive: Uint8Array): Uint8Array {
  let tar: Uint8Array;
  try {
    tar = gunzipSync(archive);
  } catch {
    throw new CloudflaredInstallError("archive_invalid", "cloudflared archive is not gzip");
  }
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeField = tarString(header, 124, 12).trim();
    const size = /^[0-7]+$/.test(sizeField) ? Number.parseInt(sizeField, 8) : Number.NaN;
    const dataStart = offset + 512;
    if (!Number.isSafeInteger(size) || dataStart + size > tar.length) {
      throw new CloudflaredInstallError("archive_invalid", "cloudflared archive has a truncated or invalid entry");
    }
    if (TAR_MEMBER_NAMES.has(fullName)) {
      const type = header[156];
      if (type !== 0x30 && type !== 0) {
        throw new CloudflaredInstallError("archive_invalid", "cloudflared archive member is not a regular file");
      }
      return tar.slice(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new CloudflaredInstallError("archive_invalid", "cloudflared archive does not contain `cloudflared`");
}

function tarString(header: Uint8Array, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return Buffer.from(end === -1 ? field : field.subarray(0, end)).toString("utf8");
}

function isPrivateRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    const uid = process.getuid?.();
    return (
      stat.isFile() && (stat.mode & 0o077) === 0 && (stat.mode & 0o100) !== 0 && (uid === undefined || stat.uid === uid)
    );
  } catch {
    return false;
  }
}

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function defaultRunVersion(path: string): CommandOutput {
  const result = spawnSync(path, ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
    env: { PATH: process.env.PATH ?? "" },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
