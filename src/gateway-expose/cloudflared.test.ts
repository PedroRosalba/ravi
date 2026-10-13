import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  CLOUDFLARED_ASSETS,
  CLOUDFLARED_VERSION,
  type CloudflaredAsset,
  type CloudflaredFetch,
  type CloudflaredPlatformKey,
  cloudflaredPlatformKey,
  extractCloudflaredFromTgz,
  installCloudflared,
  locateCloudflared,
  pinnedCloudflaredPath,
} from "./cloudflared.js";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function tarEntry(name: string, data: Uint8Array, type = "0"): Uint8Array {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000755\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.fill(" ", 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  Buffer.from(data).copy(padded);
  return Buffer.concat([header, padded]);
}

const tgz = (...entries: Uint8Array[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

const BINARY = Buffer.from("#!/bin/sh\necho fake cloudflared\n");
const VERSION_OK = { status: 0, stdout: `cloudflared version ${CLOUDFLARED_VERSION} (built 2026-09-11)\n`, stderr: "" };

function assetsFor(key: CloudflaredPlatformKey, asset: CloudflaredAsset) {
  return { ...CLOUDFLARED_ASSETS, [key]: asset };
}

/** github.com answers with a redirect to `redirectTo`; that host serves `body`. */
function fakeRelease(body: Uint8Array, redirectTo = "https://release-assets.githubusercontent.com/blob") {
  const calls: string[] = [];
  const fetch: CloudflaredFetch = async (url) => {
    calls.push(url);
    if (new URL(url).hostname === "github.com") {
      return new Response(null, { status: 302, headers: { location: redirectTo } });
    }
    return new Response(body, { status: 200 });
  };
  return { fetch, calls };
}

let binDir: string;
beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "ravi-cloudflared-"));
});
afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
});

const leftovers = () => readdirSync(binDir);

describe("pinned release table", () => {
  test("every supported platform has a 64-hex SHA-256 and a URL on the pinned GitHub release", () => {
    expect(Object.keys(CLOUDFLARED_ASSETS).sort()).toEqual([
      "darwin-amd64",
      "darwin-arm64",
      "linux-amd64",
      "linux-arm64",
    ]);
    for (const [key, asset] of Object.entries(CLOUDFLARED_ASSETS)) {
      expect(asset.sha256, key).toMatch(/^[0-9a-f]{64}$/);
      expect(asset.url, key).toStartWith(
        `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-${key}`,
      );
      expect(asset.archive, key).toBe(key.startsWith("darwin") ? "tgz" : "binary");
    }
    expect(new Set(Object.values(CLOUDFLARED_ASSETS).map((asset) => asset.sha256)).size).toBe(4);
  });

  test("maps node platform/arch and refuses anything else with a clear error", () => {
    expect(cloudflaredPlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(cloudflaredPlatformKey("darwin", "x64")).toBe("darwin-amd64");
    expect(cloudflaredPlatformKey("linux", "x64")).toBe("linux-amd64");
    expect(cloudflaredPlatformKey("linux", "arm64")).toBe("linux-arm64");
    for (const [platform, arch] of [
      ["win32", "x64"],
      ["linux", "ia32"],
      ["freebsd", "x64"],
    ] as const) {
      expect(() => cloudflaredPlatformKey(platform, arch)).toThrow(/No pinned cloudflared .* build for/);
    }
  });
});

describe("installCloudflared", () => {
  test("downloads through an allowed redirect, checks the hash, installs 0700 and checks --version", async () => {
    const { fetch, calls } = fakeRelease(BINARY);
    const versionCalls: string[] = [];
    const installed = await installCloudflared({
      fetch,
      platform: "linux",
      arch: "x64",
      binDir,
      assets: assetsFor("linux-amd64", {
        url: CLOUDFLARED_ASSETS["linux-amd64"].url,
        sha256: sha256(BINARY),
        archive: "binary",
      }),
      runVersion: (path) => {
        versionCalls.push(path);
        return VERSION_OK;
      },
    });
    expect(installed).toMatchObject({
      path: pinnedCloudflaredPath(binDir),
      reused: false,
      version: CLOUDFLARED_VERSION,
    });
    expect(calls).toEqual([CLOUDFLARED_ASSETS["linux-amd64"].url, "https://release-assets.githubusercontent.com/blob"]);
    // The version check ran on the staged copy, before it was moved into place.
    expect(versionCalls[0]).toContain(".cloudflared-install-");
    expect(statSync(installed.path).mode & 0o777).toBe(0o700);
    expect(statSync(binDir).mode & 0o777).toBe(0o700);
    expect(leftovers()).toEqual([`cloudflared-${CLOUDFLARED_VERSION}`]);

    // Already installed and answering the pinned version: nothing is downloaded.
    const again = await installCloudflared({
      fetch: async () => {
        throw new Error("no download expected");
      },
      platform: "linux",
      arch: "x64",
      binDir,
      runVersion: () => VERSION_OK,
    });
    expect(again.reused).toBe(true);
  });

  test("extracts only the cloudflared member of a darwin tgz", async () => {
    const archive = tgz(tarEntry("._cloudflared", Buffer.from("appledouble")), tarEntry("cloudflared", BINARY));
    const { fetch } = fakeRelease(archive);
    const installed = await installCloudflared({
      fetch,
      platform: "darwin",
      arch: "arm64",
      binDir,
      assets: assetsFor("darwin-arm64", {
        url: CLOUDFLARED_ASSETS["darwin-arm64"].url,
        sha256: sha256(archive),
        archive: "tgz",
      }),
      runVersion: () => VERSION_OK,
    });
    expect(readFileSync(installed.path)).toEqual(BINARY);
  });

  test("a checksum mismatch aborts before extraction and leaves nothing installed", async () => {
    const { fetch } = fakeRelease(BINARY);
    let versionRan = false;
    await expect(
      installCloudflared({
        fetch,
        platform: "linux",
        arch: "x64",
        binDir,
        runVersion: () => {
          versionRan = true;
          return VERSION_OK;
        },
      }),
    ).rejects.toMatchObject({ code: "checksum_mismatch" });
    expect(versionRan).toBe(false);
    expect(leftovers()).toEqual([]);
    expect(existsSync(pinnedCloudflaredPath(binDir))).toBe(false);
  });

  test("a redirect to a host outside the GitHub release hosts is refused", async () => {
    for (const target of ["https://evil.example/cloudflared", "http://release-assets.githubusercontent.com/blob"]) {
      const { fetch, calls } = fakeRelease(BINARY, target);
      await expect(
        installCloudflared({
          fetch,
          platform: "linux",
          arch: "x64",
          binDir,
          assets: assetsFor("linux-amd64", {
            url: CLOUDFLARED_ASSETS["linux-amd64"].url,
            sha256: sha256(BINARY),
            archive: "binary",
          }),
          runVersion: () => VERSION_OK,
        }),
      ).rejects.toMatchObject({ code: "redirect_refused" });
      expect(calls).toHaveLength(1);
      expect(leftovers()).toEqual([]);
    }
  });

  test("a binary that does not report the pinned version is not installed", async () => {
    const { fetch } = fakeRelease(BINARY);
    await expect(
      installCloudflared({
        fetch,
        platform: "linux",
        arch: "arm64",
        binDir,
        assets: assetsFor("linux-arm64", {
          url: CLOUDFLARED_ASSETS["linux-arm64"].url,
          sha256: sha256(BINARY),
          archive: "binary",
        }),
        runVersion: () => ({ status: 0, stdout: "cloudflared version 2025.1.0\n", stderr: "" }),
      }),
    ).rejects.toMatchObject({ code: "version_mismatch" });
    expect(leftovers()).toEqual([]);
  });

  test("an unsupported platform fails before any download", async () => {
    await expect(
      installCloudflared({
        fetch: async () => {
          throw new Error("no download expected");
        },
        platform: "win32",
        arch: "x64",
        binDir,
      }),
    ).rejects.toMatchObject({ code: "unsupported_platform" });
  });
});

describe("extractCloudflaredFromTgz", () => {
  test("refuses a symlink or a missing member", () => {
    expect(() => extractCloudflaredFromTgz(tgz(tarEntry("cloudflared", Buffer.alloc(0), "2")))).toThrow(
      /not a regular file/,
    );
    expect(() => extractCloudflaredFromTgz(tgz(tarEntry("other", BINARY)))).toThrow(/does not contain/);
    expect(() => extractCloudflaredFromTgz(Buffer.from("not gzip"))).toThrow(/not gzip/);
    expect(Buffer.from(extractCloudflaredFromTgz(tgz(tarEntry("./cloudflared", BINARY))))).toEqual(BINARY);
  });
});

describe("locateCloudflared", () => {
  test("prefers the pinned install; an explicit path is reported unverified", () => {
    expect(locateCloudflared({ binDir })).toMatchObject({ found: false, reason: "not_installed" });
    const pinned = pinnedCloudflaredPath(binDir);
    writeFileSync(pinned, BINARY, { mode: 0o700 });
    expect(locateCloudflared({ binDir })).toEqual({
      found: true,
      path: pinned,
      verified: true,
      source: "pinned",
      version: CLOUDFLARED_VERSION,
    });
    // A group- or world-accessible pinned binary is not trusted.
    chmodSync(pinned, 0o755);
    expect(locateCloudflared({ binDir })).toMatchObject({ found: false, reason: "not_installed" });

    expect(locateCloudflared({ binDir, explicitPath: pinned })).toEqual({
      found: true,
      path: pinned,
      verified: false,
      source: "explicit",
      version: null,
    });
    expect(locateCloudflared({ explicitPath: "cloudflared" })).toMatchObject({
      found: false,
      reason: "explicit_invalid",
    });
    expect(locateCloudflared({ explicitPath: join(binDir, "missing") })).toMatchObject({ found: false });
  });
});
