import { describe, expect, it } from "bun:test";
import { userInfo } from "node:os";
import { join } from "node:path";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { contractErrorResponse } from "../sdk/gateway/errors.js";
import { renderContractError } from "./agent-contract.js";
import { cloudErrorToContractError } from "./cloud-error-contract.js";
import {
  FILE_NOT_FOUND_CODE,
  FILE_NOT_FOUND_MESSAGE,
  FILE_NOT_FOUND_SUGGESTED_ACTION,
  MEDIA_SEND_FAILED_CODE,
  MEDIA_SEND_FAILED_MESSAGE,
  MEDIA_SEND_FAILED_SUGGESTED_ACTION,
  OMNI_AUTH_FAILED_CODE,
  OMNI_AUTH_FAILED_MESSAGE,
  OMNI_AUTH_FAILED_SUGGESTED_ACTION,
} from "./media-send-auth.js";
import {
  CALLER_CWD_HEADER,
  dispatchRemote,
  gatewayRequiredError,
  getHomeGatewayConfig,
  getRemoteGatewayConfig,
  HOME_RESPONSE_MAX_BYTES,
  homeGatewayErrorToContractError,
  isLoopbackGatewayHost,
  requiresRemoteGateway,
  resolveHostCliGatewayStateDirs,
  resolveRemoteGatewayConfig,
  remoteDispatchOutput,
  remoteGatewayErrorToContractError,
  remoteGatewayExitCode,
  type RemoteDispatchResult,
} from "./remote-gateway.js";

describe("remote gateway response bytes", () => {
  it("preserves arbitrary binary payloads without UTF-8 round-tripping", async () => {
    const bytes = new Uint8Array([0xff, 0x00, 0x42, 0x80]);
    const response = await dispatchRemote({
      groupSegments: ["artifacts"],
      command: "blob",
      body: { id: "artifact-1" },
      config: { url: "https://gateway.example", source: "env" },
      contextKey: "rctx_test",
      cwd: "/tmp/agent-workspace",
      fetchImpl: ((input: string, init?: { headers?: Record<string, string> }) => {
        void input;
        expect(new Headers(init?.headers).get(CALLER_CWD_HEADER)).toBe("/tmp/agent-workspace");
        return Promise.resolve(
          new Response(bytes, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          }),
        );
      }) as unknown as typeof fetch,
    });

    expect(response.ok).toBe(true);
    expect(response.bodyBytes).toEqual(bytes);
    expect(remoteDispatchOutput(response)).toEqual({ kind: "bytes", value: bytes });
  });

  it("adds formatting only to textual output", () => {
    expect(
      remoteDispatchOutput({
        status: 200,
        ok: true,
        body: '{"ok":true}',
        contentType: "application/json",
      }),
    ).toEqual({ kind: "text", value: '{\n  "ok": true\n}\n' });
  });
});

describe("remote gateway configuration", () => {
  it("distinguishes an unset gateway from an invalid configured URL", () => {
    expect(getRemoteGatewayConfig({})).toBeNull();
    for (const value of ["not a URL", "file:///tmp/ravi", "unix:relative.sock"]) {
      let failure: unknown;
      try {
        getRemoteGatewayConfig({ RAVI_GATEWAY_URL: value });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "REMOTE_GATEWAY_INVALID", exitCode: 2 });
    }
  });

  it("accepts plaintext HTTP only for a loopback host, and any HTTPS host", () => {
    for (const value of [
      "http://127.0.0.1:7777",
      "http://localhost",
      "http://[::1]:1",
      "http://127.4.5.6/",
      "https://x",
    ]) {
      expect(getRemoteGatewayConfig({ RAVI_GATEWAY_URL: value })).toEqual({
        url: value.replace(/\/+$/, ""),
        source: "env",
      });
    }
  });

  it("refuses plaintext HTTP to any other host with REMOTE_GATEWAY_INSECURE (exit 2)", () => {
    for (const value of [
      "http://gateway.example",
      "http://127.0.0.1.evil.com",
      "http://0.0.0.0",
      "http://10.0.0.5",
      "HTTP://EXAMPLE",
      "http://user@127.0.0.1@evil",
      "http://127.0.0.1:80@evil.example",
      "http://localhost.evil.example",
      "http://evil.localhost",
      "http://[::ffff:10.0.0.5]",
      "http://192.168.1.10:7777",
    ]) {
      let failure: unknown;
      try {
        getRemoteGatewayConfig({ RAVI_GATEWAY_URL: value });
      } catch (error) {
        failure = error;
      }
      expect({ value, failure }).toMatchObject({
        value,
        failure: { code: "REMOTE_GATEWAY_INSECURE", exitCode: 2 },
      });
    }
  });

  it("refuses an insecure RAVI_GATEWAY_URL before auto-bridging", async () => {
    await expect(
      resolveRemoteGatewayConfig(
        { RAVI_CONTEXT_KEY: "rctx_test", RAVI_GATEWAY_URL: "http://gateway.example" },
        "pages published",
        { stateDir: "/home/user/.ravi", probeSocket: async () => true },
      ),
    ).rejects.toMatchObject({ code: "REMOTE_GATEWAY_INSECURE", exitCode: 2 });
  });

  it("treats only literal loopback addresses and localhost as loopback", () => {
    expect(isLoopbackGatewayHost("127.0.0.1")).toBe(true);
    expect(isLoopbackGatewayHost("127.255.255.254")).toBe(true);
    expect(isLoopbackGatewayHost("[::1]")).toBe(true);
    expect(isLoopbackGatewayHost("LOCALHOST")).toBe(true);
    expect(isLoopbackGatewayHost("127.0.0.1.nip.io")).toBe(false);
    expect(isLoopbackGatewayHost("128.0.0.1")).toBe(false);
    expect(isLoopbackGatewayHost("[::]")).toBe(false);
    expect(isLoopbackGatewayHost("app.localhost")).toBe(false);
  });

  it("accepts an explicit unix socket URL without opening loopback HTTP", () => {
    expect(getRemoteGatewayConfig({ RAVI_GATEWAY_URL: "unix:///home/user/.ravi/cli-gateway.sock" })).toEqual({
      url: "unix:///home/user/.ravi/cli-gateway.sock",
      source: "env",
      socketPath: "/home/user/.ravi/cli-gateway.sock",
    });
  });

  it("auto-bridges isolated CLIs to a reachable host unix socket", async () => {
    const config = await resolveRemoteGatewayConfig({ RAVI_CONTEXT_KEY: "rctx_test" }, "pages published", {
      stateDir: "/home/user/.ravi",
      probeSocket: async (socketPath) => socketPath === "/home/user/.ravi/cli-gateway.sock",
    });

    expect(config).toEqual({
      url: "unix:///home/user/.ravi/cli-gateway.sock",
      source: "host-socket",
      socketPath: "/home/user/.ravi/cli-gateway.sock",
    });
  });

  it("does not auto-bridge without a context key, a reachable socket, or when disabled", async () => {
    expect(
      await resolveRemoteGatewayConfig({}, "pages published", {
        stateDir: "/home/user/.ravi",
        probeSocket: async () => true,
      }),
    ).toBeNull();
    expect(
      await resolveRemoteGatewayConfig(
        { RAVI_CONTEXT_KEY: "rctx_test", RAVI_HOST_CLI_GATEWAY: "0" },
        "pages published",
        { stateDir: "/home/user/.ravi", probeSocket: async () => true },
      ),
    ).toBeNull();
    expect(
      await resolveRemoteGatewayConfig({ RAVI_CONTEXT_KEY: "rctx_test" }, "pages published", {
        stateDir: "/home/user/.ravi",
        probeSocket: async () => false,
      }),
    ).toBeNull();
    expect(
      await resolveRemoteGatewayConfig(
        { RAVI_CONTEXT_KEY: "rctx_test", RAVI_GATEWAY_URL: "https://gateway.example" },
        "pages published",
        { stateDir: "/home/user/.ravi", probeSocket: async () => true },
      ),
    ).toEqual({ url: "https://gateway.example", source: "env" });
  });

  it("does not throw when an isolated CLI probes a missing host socket", async () => {
    await expect(
      resolveRemoteGatewayConfig({ RAVI_CONTEXT_KEY: "rctx_test" }, "pages published", {
        stateDir: "/tmp/ravi-missing-host-cli-gateway-state",
      }),
    ).resolves.toBeNull();
  });

  it("treats a throwing socket probe as unreachable instead of crashing the CLI", async () => {
    await expect(
      resolveRemoteGatewayConfig({ RAVI_CONTEXT_KEY: "rctx_test" }, "pages published", {
        stateDir: "/home/user/.ravi",
        probeSocket: async () => {
          throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
        },
      }),
    ).resolves.toBeNull();
  });
});

function result(overrides: Partial<RemoteDispatchResult>): RemoteDispatchResult {
  return {
    status: 500,
    ok: false,
    body: "",
    contentType: "application/json",
    ...overrides,
  };
}

describe("remote gateway exit taxonomy", () => {
  it.each([1, 2, 3] as const)("preserves contract exit %i", (exitCode) => {
    const outcome = exitCode === 2 ? "usage_error" : exitCode === 3 ? "blocked" : "failed";
    expect(
      remoteGatewayExitCode(
        result({
          body: JSON.stringify({
            success: false,
            op: "commands list",
            exitCode,
            outcome,
            error: { code: "DEMO_ERROR", message: "safe failure", retryable: false },
          }),
        }),
      ),
    ).toBe(exitCode);
  });

  it("keeps success at zero and malformed or legacy failures at one", () => {
    expect(remoteGatewayExitCode(result({ ok: true, status: 200 }))).toBe(0);
    expect(remoteGatewayExitCode(result({ body: "not-json" }))).toBe(1);
    expect(remoteGatewayExitCode(result({ body: JSON.stringify({ error: "legacy" }) }))).toBe(1);
    expect(remoteGatewayExitCode(result({ body: JSON.stringify({ success: false, exitCode: 3 }) }))).toBe(1);
  });

  it("normalizes legacy permission responses into the canonical contract", () => {
    const error = remoteGatewayErrorToContractError(
      "commands list",
      result({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "PermissionDenied", reason: "PRIVATE_MESSAGE_8K2R" }),
      }),
    );

    expect(error).toMatchObject({
      op: "commands list",
      code: "PERMISSION_DENIED",
      exitCode: 1,
      message: "Remote gateway denied the command.",
    });
    expect(error?.envelope()).toMatchObject({ success: false, error: { code: "PERMISSION_DENIED" } });
    expect(JSON.stringify(error?.envelope())).not.toContain("PRIVATE_MESSAGE_8K2R");
  });

  it("redacts malformed remote failures as retryable server errors", () => {
    const error = remoteGatewayErrorToContractError(
      "commands list",
      result({ status: 503, contentType: "text/plain", body: "private upstream response" }),
    );

    expect(error).toMatchObject({
      op: "commands list",
      code: "SERVER_UNAVAILABLE",
      exitCode: 1,
      details: { status: 503, retryable: true },
    });
    expect(JSON.stringify(error?.envelope())).not.toContain("private upstream response");
  });

  it("preserves a remote PAYLOAD_INVALID issue instead of the generic rejection", () => {
    const error = remoteGatewayErrorToContractError(
      "pages ship",
      result({
        status: 400,
        body: JSON.stringify({
          success: false,
          op: "pages ship",
          exitCode: 2,
          outcome: "usage_error",
          error: {
            code: "PAYLOAD_INVALID",
            message: "--html file was not found: ./index.html",
            retryable: false,
            suggestedAction: "correct the command input and retry",
            issues: [{ path: ["html"], code: "invalid", message: "--html file was not found: ./index.html" }],
          },
        }),
      }),
    );

    expect(error).toMatchObject({
      op: "pages ship",
      code: "PAYLOAD_INVALID",
      exitCode: 2,
      message: "html: --html file was not found: ./index.html",
    });
    expect(error?.details.suggestedAction).toBe("Correct the command input and retry");
    expect(JSON.stringify(error?.envelope())).toContain("--html file was not found: ./index.html");
  });

  it("preserves a safe PAYLOAD_INVALID message when the remote omitted issues", () => {
    const error = remoteGatewayErrorToContractError(
      "pages ship",
      result({
        status: 400,
        body: JSON.stringify({
          success: false,
          op: "pages ship",
          exitCode: 2,
          outcome: "usage_error",
          error: {
            code: "PAYLOAD_INVALID",
            message: "Missing Console project. Pass --project <project-ref>.",
            retryable: false,
          },
        }),
      }),
    );

    expect(error).toMatchObject({
      code: "PAYLOAD_INVALID",
      message: "Missing Console project. Pass --project <project-ref>.",
    });
    expect(JSON.stringify(error?.envelope())).not.toContain("Remote gateway rejected the command input");
  });

  it("projects 400 validation issues into a usage error", () => {
    const error = remoteGatewayErrorToContractError(
      "tasks create",
      result({
        status: 400,
        body: JSON.stringify({
          error: "ValidationError",
          issues: [
            { path: ["title"], code: "invalid_type", message: "Expected string, received undefined" },
            { providerBody: "PRIVATE_MESSAGE_8K2R" },
          ],
        }),
      }),
    );

    expect(error).toMatchObject({
      op: "tasks create",
      code: "USAGE_ERROR",
      exitCode: 2,
      message: "title: Expected string, received undefined",
      details: {
        status: 400,
        issues: [{ path: ["title"], code: "invalid_type", message: "Expected string, received undefined" }],
      },
    });
    expect(JSON.stringify(error?.envelope())).toContain("Expected string, received undefined");
    expect(JSON.stringify(error?.envelope())).not.toContain("PRIVATE_MESSAGE_8K2R");
  });

  it("projects 422 contract issues without changing the remote taxonomy", () => {
    const error = remoteGatewayErrorToContractError(
      "tasks create",
      result({
        status: 422,
        body: JSON.stringify({
          success: false,
          op: "tasks create",
          exitCode: 1,
          outcome: "failed",
          error: {
            code: "COMMAND_FAILED",
            message: "Command could not be completed.",
            retryable: false,
            issues: [{ path: ["instructions"], code: "too_small", message: "Required" }],
          },
        }),
      }),
    );

    expect(error).toMatchObject({
      op: "tasks create",
      code: "COMMAND_FAILED",
      exitCode: 1,
      details: {
        status: 422,
        retryable: false,
        issues: [{ path: ["instructions"], code: "too_small", message: "Required" }],
      },
    });
    expect(error?.envelope()).toMatchObject({
      error: {
        code: "COMMAND_FAILED",
        message: "instructions: Required",
        status: 422,
        issues: [{ path: ["instructions"], code: "too_small", message: "Required" }],
      },
    });
  });

  it("prints HTTP status and issues in text CLI output", () => {
    const error = remoteGatewayErrorToContractError(
      "tasks create",
      result({
        status: 400,
        body: JSON.stringify({
          error: "ValidationError",
          issues: [{ path: ["title"], code: "invalid_type", message: "Expected string, received undefined" }],
        }),
      }),
    );
    expect(error).not.toBeNull();
    const lines: string[] = [];
    const originalError = console.error;
    console.error = ((line?: unknown) => {
      lines.push(String(line ?? ""));
    }) as typeof console.error;
    try {
      renderContractError(error!, false);
    } finally {
      console.error = originalError;
    }
    expect(lines).toEqual(["title: Expected string, received undefined", "status: 400"]);
  });

  it("rejects partial or incoherent contract-looking responses", () => {
    const partial = remoteGatewayErrorToContractError(
      "commands list",
      result({
        status: 409,
        body: JSON.stringify({
          success: false,
          op: "commands list",
          exitCode: 3,
          error: { code: "WRITE_REQUIRES_EXECUTE", message: "raw private response" },
        }),
      }),
    );
    const wrongOperation = remoteGatewayErrorToContractError(
      "commands list",
      result({
        status: 409,
        body: JSON.stringify({
          success: false,
          op: "secrets reveal",
          exitCode: 3,
          outcome: "blocked",
          error: { code: "WRITE_REQUIRES_EXECUTE", message: "blocked", retryable: false },
        }),
      }),
    );

    expect(partial).toMatchObject({ code: "SERVER_UNAVAILABLE", exitCode: 1 });
    expect(JSON.stringify(partial?.envelope())).not.toContain("raw private response");
    expect(wrongOperation).toMatchObject({ code: "SERVER_UNAVAILABLE", exitCode: 1 });
  });

  it.each([
    [1, "failed", "WRITE_REQUIRES_EXECUTE"],
    [1, "failed", "USAGE_ERROR"],
  ] as const)("rejects exit %i/%s with policy code %s", (exitCode, outcome, code) => {
    const error = remoteGatewayErrorToContractError(
      "commands list",
      result({
        status: 409,
        body: JSON.stringify({
          success: false,
          op: "commands list",
          exitCode,
          outcome,
          error: { code, message: "private mismatch", retryable: false },
        }),
      }),
    );

    expect(error).toMatchObject({ code: "SERVER_UNAVAILABLE", exitCode: 1 });
    expect(JSON.stringify(error?.envelope())).not.toContain("private mismatch");
  });

  it.each([
    [1, "failed", "COMMAND_FAILED", "Remote command failed."],
    [1, "denied", "PERMISSION_DENIED", "Remote gateway denied the command."],
    [2, "usage_error", "USAGE_ERROR", "Remote gateway rejected the command input."],
    [
      3,
      "blocked",
      "WRITE_REQUIRES_EXECUTE",
      "Dry-run: nothing was written. Re-run with --execute to perform the write.",
    ],
    [3, "blocked", "POLICY_BLOCKED", "Remote command was blocked by policy."],
  ] as const)(
    "projects a complete exit %i/%s response into a safe local contract",
    (exitCode, outcome, code, message) => {
      const error = remoteGatewayErrorToContractError(
        "commands list",
        result({
          status: 409,
          body: JSON.stringify({
            success: false,
            op: "commands list",
            exitCode,
            outcome,
            providerBody: "PRIVATE_MESSAGE_8K2R",
            plan: { token: "SENTINEL_SECRET_7M4Q" },
            error: {
              code,
              message: "PRIVATE_MESSAGE_8K2R",
              retryable: true,
              metadata: { secret: "SENTINEL_SECRET_7M4Q" },
            },
          }),
        }),
      );

      expect(error).toMatchObject({ op: "commands list", code, exitCode, message, details: { retryable: true } });
      expect(error?.envelope().error.message).toBe(message);
      const serialized = JSON.stringify(error?.envelope());
      expect(serialized).not.toContain("PRIVATE_MESSAGE_8K2R");
      expect(serialized).not.toContain("SENTINEL_SECRET_7M4Q");
      expect(serialized).not.toContain("providerBody");
      expect(serialized).not.toContain("metadata");
    },
  );

  it("tells a remote dry-run to add --execute instead of reporting a policy block", () => {
    // `ravi bug comment <id>` without --execute from an agent session used to print
    // "Remote command was blocked by policy.", hiding the write brake's next step.
    const error = remoteGatewayErrorToContractError(
      "bug comment",
      result({
        status: 409,
        body: JSON.stringify({
          success: false,
          op: "bug comment",
          exitCode: 3,
          outcome: "blocked",
          error: {
            code: "WRITE_REQUIRES_EXECUTE",
            message: "PRIVATE_MESSAGE_8K2R",
            retryable: false,
            dryRun: true,
            plan: { textPresent: true },
          },
        }),
      }),
    );

    expect(error?.envelope().error).toMatchObject({
      code: "WRITE_REQUIRES_EXECUTE",
      message: "Dry-run: nothing was written. Re-run with --execute to perform the write.",
      suggestedAction: "Re-run 'bug comment' adding --execute to perform the write",
      dryRun: true,
    });
    expect(error?.exitCode).toBe(3);
    expect(JSON.stringify(error?.envelope())).not.toContain("PRIVATE_MESSAGE_8K2R");
  });

  it("rejects an invalid remote error code instead of reflecting it", () => {
    const error = remoteGatewayErrorToContractError(
      "commands list",
      result({
        body: JSON.stringify({
          success: false,
          op: "commands list",
          exitCode: 1,
          outcome: "failed",
          error: { code: "private:SENTINEL_SECRET_7M4Q", message: "safe", retryable: false },
        }),
      }),
    );

    expect(error).toMatchObject({ code: "SERVER_UNAVAILABLE", exitCode: 1 });
    expect(JSON.stringify(error?.envelope())).not.toContain("SENTINEL_SECRET_7M4Q");
  });

  it("preserves only allowlisted and sanitized agent-first details", () => {
    const oversizedPosition = `<${"a".repeat(65)}>`;
    const error = remoteGatewayErrorToContractError(
      "commands list",
      result({
        status: 409,
        body: JSON.stringify({
          success: false,
          op: "commands list",
          exitCode: 3,
          outcome: "blocked",
          error: {
            code: "WRITE_REQUIRES_EXECUTE",
            message: "PRIVATE_MESSAGE_8K2R",
            retryable: false,
            suggestedAction: "PRIVATE_MESSAGE_8K2R",
            suggestions: [
              "Alice Smith",
              "CRM-42",
              "calendar_main",
              "C:/sentinel/private",
              "sk-abcdefghijklmnop",
              { secret: "SENTINEL_SECRET_7M4Q" },
            ],
            acceptedFlags: ["--json", "PRIVATE_MESSAGE_8K2R"],
            acceptedPositionals: [
              "<opportunity>",
              "[text]",
              "<name...>",
              "SENTINEL_SECRET_7M4Q",
              "PRIVATE MESSAGE",
              oversizedPosition,
            ],
            dryRun: true,
            plan: {
              operation: "publish",
              resource: "artifact",
              resourceId: "artifact_123",
              provider: "sk-abcdefghijklmnop",
              contextId: "rctx_private_context",
              captionPresent: true,
              messageChars: 20,
              attachmentCount: 1,
              target: "commands",
              token: "SENTINEL_SECRET_7M4Q",
              message: "PRIVATE_MESSAGE_8K2R",
              filePath: "C:/sentinel/private/file-9P3X.txt",
              privateNote: "private-note",
              destination: { channelId: "channel_123", label: "PRIVATE_LABEL_8K2R" },
            },
            details: { arbitrary: "PRIVATE_DETAILS_8K2R" },
            issues: [{ providerBody: "PRIVATE_MESSAGE_8K2R" }],
          },
        }),
      }),
    );

    expect(error?.envelope().error).toMatchObject({
      suggestedAction: "Re-run 'commands list' adding --execute to perform the write",
      suggestions: ["CRM-42", "calendar_main"],
      acceptedFlags: ["--json"],
      acceptedPositionals: ["<opportunity>", "[text]", "<name...>"],
      dryRun: true,
      plan: {
        operation: "publish",
        resource: "artifact",
        resourceId: "artifact_123",
        captionPresent: true,
        messageChars: 20,
        attachmentCount: 1,
        destination: { channelId: "channel_123" },
      },
    });
    const serialized = JSON.stringify(error?.envelope());
    expect(serialized).not.toContain("Alice Smith");
    expect(serialized).not.toContain("PRIVATE_MESSAGE_8K2R");
    expect(serialized).not.toContain("SENTINEL_SECRET_7M4Q");
    expect(serialized).not.toContain("sk-abcdefghijklmnop");
    expect(serialized).not.toContain("rctx_private_context");
    expect(serialized).not.toContain("C:/sentinel/private");
    expect(serialized).not.toContain("issues");
    expect(serialized).not.toContain("privateNote");
    expect(serialized).not.toContain("PRIVATE_DETAILS_8K2R");
    expect(serialized).not.toContain("PRIVATE_LABEL_8K2R");
    expect(serialized).not.toContain('"target"');
    expect(serialized).not.toContain(oversizedPosition);
  });

  it("keeps representative native dry-run plans actionable after remote projection", () => {
    const cases = [
      {
        op: "agents delete",
        plan: { agentId: "main", cwdPresent: true, namePresent: false },
      },
      {
        op: "agents permissions",
        plan: {
          agentId: "main",
          beforePresent: true,
          beforeProfile: "none",
          beforeCapabilitiesCount: 0,
          afterPresent: true,
          afterProfile: "full-access",
          afterCapabilitiesCount: 3,
        },
      },
      {
        op: "artifacts publish",
        plan: {
          target: { kind: "artifact", artifactId: "art_123" },
          project: "project-main",
          site: "public-site",
          routePresent: true,
          visibility: "public",
          namePresent: true,
          slug: "landing-page",
          entrypointPresent: true,
          artifactVersion: 2,
          activate: true,
          replaceRelease: false,
        },
      },
      {
        op: "whatsapp dm send",
        plan: {
          channel: "whatsapp",
          accountId: "default",
          targetType: "contact",
          targetRef: "sha256:0123456789abcdef",
          effect: "send-message",
          messageChars: 20,
        },
      },
    ] as const;

    for (const testCase of cases) {
      const error = remoteGatewayErrorToContractError(
        testCase.op,
        result({
          status: 409,
          body: JSON.stringify({
            success: false,
            op: testCase.op,
            exitCode: 3,
            outcome: "blocked",
            error: {
              code: "WRITE_REQUIRES_EXECUTE",
              message: "private remote message",
              retryable: false,
              dryRun: true,
              plan: testCase.plan,
            },
          }),
        }),
      );

      expect(error?.envelope().error).toMatchObject({ dryRun: true, plan: testCase.plan });
    }
  });

  it.each([
    [MEDIA_SEND_FAILED_CODE, true, MEDIA_SEND_FAILED_MESSAGE, MEDIA_SEND_FAILED_SUGGESTED_ACTION],
    [OMNI_AUTH_FAILED_CODE, false, OMNI_AUTH_FAILED_MESSAGE, OMNI_AUTH_FAILED_SUGGESTED_ACTION],
    [FILE_NOT_FOUND_CODE, false, FILE_NOT_FOUND_MESSAGE, FILE_NOT_FOUND_SUGGESTED_ACTION],
  ] as const)(
    "projects isolated media send %s through the local catalog without remote text",
    (code, retryable, message, suggestedAction) => {
      const error = remoteGatewayErrorToContractError(
        "media send",
        result({
          status: 500,
          body: JSON.stringify({
            success: false,
            op: "media send",
            exitCode: 1,
            outcome: "failed",
            error: {
              code,
              message: "PRIVATE_MESSAGE_8K2R sk-abcdefghijklmnop omni://internal",
              retryable,
              suggestedAction: "PRIVATE_ACTION_8K2R",
            },
          }),
        }),
      );

      expect(error).toMatchObject({
        op: "media send",
        code,
        exitCode: 1,
        message,
        details: { retryable, suggestedAction },
      });
      const serialized = JSON.stringify(error?.envelope());
      expect(serialized).not.toContain("PRIVATE_MESSAGE_8K2R");
      expect(serialized).not.toContain("PRIVATE_ACTION_8K2R");
      expect(serialized).not.toContain("sk-abcdefghijklmnop");
      expect(serialized).not.toContain("omni://internal");
    },
  );

  it("keeps generic isolated media send failures as Remote command failed", () => {
    const error = remoteGatewayErrorToContractError(
      "media send",
      result({
        status: 500,
        body: JSON.stringify({
          success: false,
          op: "media send",
          exitCode: 1,
          outcome: "failed",
          error: {
            code: "COMMAND_FAILED",
            message: "PRIVATE_MESSAGE_8K2R",
            retryable: true,
          },
        }),
      }),
    );

    expect(error).toMatchObject({
      op: "media send",
      code: "COMMAND_FAILED",
      message: "Remote command failed.",
      details: { retryable: true },
    });
    expect(JSON.stringify(error?.envelope())).not.toContain("PRIVATE_MESSAGE_8K2R");
  });

  it("does not apply the media catalog when a different op reuses a catalog code", () => {
    const error = remoteGatewayErrorToContractError(
      "transcribe file",
      result({
        status: 404,
        body: JSON.stringify({
          success: false,
          op: "transcribe file",
          exitCode: 1,
          outcome: "failed",
          error: {
            code: FILE_NOT_FOUND_CODE,
            message: "PRIVATE_MESSAGE_8K2R",
            retryable: false,
          },
        }),
      }),
    );

    expect(error).toMatchObject({
      op: "transcribe file",
      code: FILE_NOT_FOUND_CODE,
      message: "Remote command failed.",
    });
    expect(error?.message).not.toBe(FILE_NOT_FOUND_MESSAGE);
    expect(JSON.stringify(error?.envelope())).not.toContain("PRIVATE_MESSAGE_8K2R");
  });
});

describe("ravi link failures over the gateway", () => {
  it.each(["CONTACT_REQUIRED", "LINK_DM_UNSUPPORTED", "LINK_DM_FAILED", "AUTH_REQUIRED"] as const)(
    "keeps the local message and next step for %s",
    async (code) => {
      const local = cloudErrorToContractError("identity link", new CloudAuthError(code, "PRIVATE_MESSAGE_8K2R U0LUIS"));
      const response = contractErrorResponse(local);

      const error = remoteGatewayErrorToContractError(
        "identity link",
        result({ status: response.status, body: await response.text() }),
      );

      expect(error).toMatchObject({
        op: "identity link",
        code,
        message: local.message,
        details: { suggestedAction: local.details.suggestedAction },
      });
      expect(error?.message).not.toBe("Remote command failed.");
      const serialized = JSON.stringify(error?.envelope());
      expect(serialized).not.toContain("PRIVATE_MESSAGE_8K2R");
      expect(serialized).not.toContain("U0LUIS");
    },
  );
});

describe("gateway requirement for runtime context keys", () => {
  it("requires the gateway whenever a context key is present", () => {
    expect(requiresRemoteGateway({ RAVI_CONTEXT_KEY: "rctx_test" })).toBe(true);
    expect(requiresRemoteGateway({ RAVI_CONTEXT_KEY: "rctx_test", RAVI_HOST_CLI_GATEWAY: "0" })).toBe(true);
    expect(requiresRemoteGateway({ RAVI_CONTEXT_KEY: "rctx_test", RAVI_GATEWAY_INTERNAL: "1" })).toBe(true);
    expect(requiresRemoteGateway({ RAVI_CONTEXT_KEY: "  " })).toBe(false);
    expect(requiresRemoteGateway({})).toBe(false);
  });

  it("fails closed with a retryable GATEWAY_REQUIRED contract error", () => {
    const error = gatewayRequiredError("pages published");
    expect(error.code).toBe("GATEWAY_REQUIRED");
    expect(error.exitCode).toBe(1);
    expect(error.details.retryable).toBe(true);
    expect(error.message).not.toContain("rctx_");
  });

  it("probes only the account home, never $HOME", async () => {
    const accountDir = join(userInfo().homedir, ".ravi");
    expect(resolveHostCliGatewayStateDirs({ HOME: "/tmp/agent-controlled" })).toEqual([accountDir]);
    const probed: string[] = [];
    const config = await resolveRemoteGatewayConfig(
      { RAVI_CONTEXT_KEY: "rctx_test", HOME: "/tmp/agent-controlled" },
      "pages published",
      {
        probeSocket: async (socketPath) => {
          probed.push(socketPath);
          return true;
        },
      },
    );
    expect(probed).toEqual([join(accountDir, "cli-gateway.sock")]);
    expect(config?.socketPath).toBe(join(accountDir, "cli-gateway.sock"));
  });

  it("does not reach a socket planted under $HOME when the account home has none", async () => {
    const config = await resolveRemoteGatewayConfig(
      { RAVI_CONTEXT_KEY: "rctx_test", HOME: "/tmp/agent-controlled" },
      "pages published",
      { probeSocket: async (socketPath) => socketPath.startsWith("/tmp/agent-controlled/") },
    );
    expect(config).toBeNull();
  });

  it("keeps RAVI_STATE_DIR as the only socket location when the daemon publishes it", () => {
    expect(resolveHostCliGatewayStateDirs({ RAVI_STATE_DIR: "/srv/ravi-state", HOME: "/tmp/x" })).toEqual([
      "/srv/ravi-state",
    ]);
  });
});

describe("home gateway (ravi home)", () => {
  const homeUrl = "https://gw.example.test/i/0b6c2f0e-6a3b-4f0e-9d7a-2c1f3e4d5a6b";
  const grant = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJzYW5kYm94In0.SENTINEL_GRANT_SIG_2H7K";
  const requestId = "4f1d2c3b-5a6e-4b7c-8d9e-0a1b2c3d4e5f";

  function homeError(op: string, status: number, body: unknown, headerRequestId: string | null = null) {
    return homeGatewayErrorToContractError(op, {
      status,
      ok: false,
      body: typeof body === "string" ? body : JSON.stringify(body),
      contentType: typeof body === "string" ? "text/html" : "application/json",
      requestId: headerRequestId,
    });
  }

  function thrown(fn: () => unknown): { code?: string; exitCode?: number; message?: string } {
    try {
      fn();
    } catch (error) {
      return error as { code?: string; exitCode?: number; message?: string };
    }
    throw new Error("expected a throw");
  }

  it("accepts an https URL and marks it as grant-authenticated", () => {
    expect(getHomeGatewayConfig({ RAVI_HOME_GATEWAY_URL: `${homeUrl}//` })).toEqual({
      url: homeUrl,
      source: "home",
      auth: "sandbox-grant",
    });
  });

  it("requires RAVI_HOME_GATEWAY_URL and ignores RAVI_GATEWAY_URL", () => {
    const error = thrown(() =>
      getHomeGatewayConfig({ RAVI_GATEWAY_URL: "https://gateway.example.test", RAVI_CONTEXT_KEY: "rctx_x" }),
    );
    expect(error.code).toBe("HOME_GATEWAY_REQUIRED");
    expect(error.exitCode).toBe(1);
  });

  it("refuses http (even loopback) and unix URLs with exit 2", () => {
    for (const raw of ["http://gw.example.test/i/x", "http://127.0.0.1:7790", "unix:///tmp/ravi.sock"]) {
      const error = thrown(() => getHomeGatewayConfig({ RAVI_HOME_GATEWAY_URL: raw }));
      expect(error.code).toBe("HOME_GATEWAY_INSECURE");
      expect(error.exitCode).toBe(2);
    }
  });

  it("refuses credentials, a query or a fragment without echoing the URL", () => {
    for (const raw of [
      "https://SECRET_USER_1A:SECRET_PASS_1A@gw.example.test/i/x",
      "https://SECRET_USER_1A@gw.example.test/i/x",
      "https://gw.example.test/i/x?token=SECRET_QUERY_1A",
      "https://gw.example.test/i/x?",
      "https://gw.example.test/i/x#SECRET_FRAGMENT_1A",
      "https://gw.example.test/i/x#",
    ]) {
      const error = thrown(() => getHomeGatewayConfig({ RAVI_HOME_GATEWAY_URL: raw }));
      expect(error.code).toBe("HOME_GATEWAY_INVALID");
      expect(error.exitCode).toBe(2);
      expect(error.message).not.toContain("SECRET_");
    }
  });

  it("sends neither the context key nor the cwd nor the internal marker, and does not follow redirects", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    await dispatchRemote({
      groupSegments: ["tasks"],
      command: "report",
      body: { taskId: "task-1", message: "hi" },
      config: getHomeGatewayConfig({ RAVI_HOME_GATEWAY_URL: homeUrl }),
      contextKey: "rctx_SENTINEL_KEY_6V2N",
      cwd: "/SENTINEL_CWD_8B1X",
      env: { RAVI_CONTEXT_KEY: "rctx_SENTINEL_KEY_6V2N", RAVI_GATEWAY_URL: "https://gateway.example.test" },
      fetchImpl: (async (url: string, init?: RequestInit) => {
        seen.push({ url, init });
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    expect(seen).toHaveLength(1);
    const headers = new Headers(seen[0]?.init?.headers);
    expect(seen[0]?.url).toBe(`${homeUrl}/api/v1/tasks/report`);
    expect(Object.fromEntries(headers.entries())).toEqual({
      "content-type": "application/json",
      accept: "application/json",
    });
    expect(seen[0]?.init?.redirect).toBe("manual");
    expect(seen[0]?.init?.body).toBe(JSON.stringify({ taskId: "task-1", message: "hi" }));
    expect(JSON.stringify(seen)).not.toContain("SENTINEL");
  });

  it("adds the grant header only from RAVI_SANDBOX_GRANT", async () => {
    const grants: Array<string | null> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      grants.push(new Headers(init?.headers).get("x-ravi-sandbox-grant"));
      return Response.json({ ok: true });
    }) as typeof fetch;
    const config = getHomeGatewayConfig({ RAVI_HOME_GATEWAY_URL: homeUrl });
    const base = { groupSegments: ["tasks"], command: "show", body: { taskId: "task-1" }, config, fetchImpl };
    await dispatchRemote({ ...base, env: {} });
    await dispatchRemote({ ...base, env: { RAVI_SANDBOX_GRANT: "  " } });
    await dispatchRemote({ ...base, env: { RAVI_SANDBOX_GRANT: ` ${grant}\n` } });
    expect(grants).toEqual([null, null, grant]);
  });

  it("refuses a malformed grant before sending and never echoes it", async () => {
    let called = false;
    const config = getHomeGatewayConfig({ RAVI_HOME_GATEWAY_URL: homeUrl });
    for (const bad of [`${grant}\r\nx-injected: 1`, `${grant},${grant}`, "SENTINEL_GRANT_SIG not-a-jws"]) {
      const error = await dispatchRemote({
        groupSegments: ["tasks"],
        command: "show",
        body: { taskId: "task-1" },
        config,
        env: { RAVI_SANDBOX_GRANT: bad },
        fetchImpl: (async () => {
          called = true;
          return Response.json({ ok: true });
        }) as unknown as typeof fetch,
      }).catch((caught: unknown) => caught as { code?: string; exitCode?: number; message?: string });
      expect((error as { code?: string }).code).toBe("HOME_GRANT_INVALID");
      expect((error as { exitCode?: number }).exitCode).toBe(2);
      expect(JSON.stringify({ message: (error as Error).message, ...(error as object) })).not.toContain(
        "SENTINEL_GRANT_SIG",
      );
    }
    expect(called).toBe(false);
  });

  it("projects a Gate envelope with its request id", () => {
    const error = homeError("tasks report", 401, { error: { code: "grant_missing", requestId } });
    expect(error?.code).toBe("HOME_GRANT_MISSING");
    expect(error?.exitCode).toBe(1);
    expect(error?.message).toContain(requestId);
    expect(error?.details).toMatchObject({ status: 401, homeCode: "grant_missing", source: "gate", requestId });
  });

  it("projects a listener envelope and maps usage and policy statuses", () => {
    const listener = homeError("tasks report", 403, {
      error: { code: "resource_forbidden", requestId, source: "ravi-listener" },
    });
    expect(listener?.code).toBe("HOME_RESOURCE_FORBIDDEN");
    expect(listener?.exitCode).toBe(1);
    expect(listener?.details.source).toBe("ravi-listener");

    const notAllowed = homeError("tasks report", 403, { error: { code: "command_not_allowed", requestId } });
    expect(notAllowed?.exitCode).toBe(3);

    const invalid = homeError("tasks report", 400, {
      error: { code: "body_invalid", requestId, source: "ravi-listener" },
    });
    expect(invalid?.exitCode).toBe(2);

    const offline = homeError("tasks report", 503, { error: { code: "daemon_offline", requestId } });
    expect(offline?.details.retryable).toBe(true);
  });

  it("takes the request id from the response header and drops a malformed one", () => {
    const fromHeader = homeError("tasks show", 429, { error: { code: "rate_limited", requestId: null } }, requestId);
    expect(fromHeader?.message).toContain(requestId);

    const forged = homeError("tasks show", 401, {
      error: { code: "grant_invalid", requestId: `${grant}\u001b[2J` },
    });
    expect(forged?.message).not.toContain("SENTINEL_GRANT_SIG");
    expect(forged?.details.requestId).toBeNull();
  });

  it("never reflects an envelope that does not match the HOME shape", () => {
    for (const body of [
      { error: { code: grant, requestId } },
      { error: { code: "grant_invalid", requestId, source: "SENTINEL_GRANT_SIG" } },
      { error: "grant_invalid" },
    ]) {
      const error = homeError("tasks show", 401, body);
      expect(error?.code).toBe("HOME_GATEWAY_FAILED");
      expect(JSON.stringify(error?.envelope())).not.toContain("SENTINEL_GRANT_SIG");
    }
  });

  it("keeps the remote projection for a dispatcher contract envelope relayed by the listener", () => {
    const error = homeError("tasks show", 404, {
      success: false,
      op: "tasks show",
      exitCode: 1,
      outcome: "failed",
      error: { code: "NOT_FOUND", message: "Task not found", retryable: false },
    });
    expect(error?.code).toBe("NOT_FOUND");
    expect(error?.exitCode).toBe(1);
  });

  it("maps an edge HTML page and a redirect to HOME failures", () => {
    const edge = homeError("tasks show", 502, "<html>bad gateway</html>", requestId);
    expect(edge?.code).toBe("HOME_GATEWAY_FAILED");
    expect(edge?.details.retryable).toBe(true);
    expect(edge?.message).toContain(requestId);
    expect(edge?.message).not.toContain("html");

    const redirect = homeGatewayErrorToContractError("tasks show", {
      status: 302,
      ok: false,
      body: "",
      contentType: null,
    });
    expect(redirect?.code).toBe("HOME_GATEWAY_REDIRECT");
    expect(redirect?.exitCode).toBe(1);
  });

  // The reviewer's probe: a relayed contract envelope echoing the grant in
  // its message, issues or suggestions.
  it("scrubs the known grant from every field of a relayed contract envelope", () => {
    const jws = "eyJhbGciOiJFZERTQSIsImtpZCI6ImsxIn0.eyJzdWIiOiJydW4xIiwidGFzayI6InQxIn0.c2lnbmF0dXJlc2lnbmF0dXJl";
    for (const known of [jws, "abc.def.ghi"]) {
      for (const where of ["issue", "message", "suggestion"] as const) {
        const error: Record<string, unknown> = {
          code: "PAYLOAD_INVALID",
          message: where === "message" ? `bad grant ${known}` : "x",
          retryable: false,
        };
        if (where === "issue") error.issues = [{ path: ["taskId"], code: "invalid", message: `bad ${known}` }];
        if (where === "suggestion") error.suggestions = [known, `use ${known}`];
        const projected = homeGatewayErrorToContractError(
          "tasks report",
          {
            status: 400,
            ok: false,
            body: JSON.stringify({ success: false, op: "tasks report", exitCode: 2, outcome: "usage_error", error }),
            contentType: "application/json",
            requestId: null,
          },
          { RAVI_SANDBOX_GRANT: known },
        );
        const shown = JSON.stringify({ message: projected?.message, envelope: projected?.envelope() });
        expect(shown).not.toContain(known);
        if (where === "issue") expect(shown).toContain("bad [grant]");
      }
    }
  });

  it("scrubs a JWS-shaped token even when the egress proxy injected it and the CLI never saw it", () => {
    const injected = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJydW4yIn0.UNSEEN_PROXY_GRANT_SIG_4M";
    const projected = homeError("tasks report", 400, {
      success: false,
      op: "tasks report",
      exitCode: 2,
      outcome: "usage_error",
      error: {
        code: "PAYLOAD_INVALID",
        message: "x",
        retryable: false,
        issues: [{ path: ["taskId"], code: "invalid", message: `bad ${injected}` }],
      },
    });
    expect(JSON.stringify({ message: projected?.message, envelope: projected?.envelope() })).not.toContain(
      "UNSEEN_PROXY_GRANT_SIG",
    );
  });

  it("maps grant_header_invalid to exit 1 with the double-header advice", () => {
    const error = homeError("tasks report", 400, { error: { code: "grant_header_invalid", requestId } });
    expect(error?.code).toBe("HOME_GRANT_HEADER_INVALID");
    expect(error?.exitCode).toBe(1);
    expect(String(error?.details.suggestedAction)).toContain("unset RAVI_SANDBOX_GRANT");
  });

  it("suggests an action for the other Gate codes", () => {
    for (const [code, status] of [
      ["gate_unavailable", 503],
      ["gateway_misconfigured", 502],
      ["payload_too_large", 413],
      ["not_found", 404],
      ["method_not_allowed", 405],
    ] as const) {
      const error = homeError("tasks report", status, { error: { code, requestId } });
      expect(error?.code).toBe(`HOME_${code.toUpperCase()}`);
      expect(error?.details.suggestedAction).not.toBe("Inspect HOME's audit for this request id");
    }
  });

  it("refuses a HOME gateway on the same origin as RAVI_GATEWAY_URL", () => {
    const error = thrown(() =>
      getHomeGatewayConfig({ RAVI_HOME_GATEWAY_URL: homeUrl, RAVI_GATEWAY_URL: "https://gw.example.test/other/" }),
    );
    expect(error.code).toBe("HOME_GATEWAY_CONFLICT");
    expect(error.exitCode).toBe(2);
    expect(error.message).not.toContain("gw.example.test");
    expect(
      getHomeGatewayConfig({ RAVI_HOME_GATEWAY_URL: homeUrl, RAVI_GATEWAY_URL: "https://gw.example.test:8443" }).url,
    ).toBe(homeUrl);
  });

  it("aborts a HOME response larger than the bound and keeps nothing of it", async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    let signal: AbortSignal | undefined;
    const error = await dispatchRemote({
      groupSegments: ["tasks"],
      command: "show",
      body: { taskId: "task-1" },
      config: getHomeGatewayConfig({ RAVI_HOME_GATEWAY_URL: homeUrl }),
      env: {},
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Response(endless, { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    }).catch((caught: unknown) => caught as { code?: string; exitCode?: number });
    expect((error as { code?: string }).code).toBe("HOME_RESPONSE_TOO_LARGE");
    expect((error as { exitCode?: number }).exitCode).toBe(1);
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(pulled).toBeLessThan(HOME_RESPONSE_MAX_BYTES + 4 * chunk.byteLength);

    const declared = await dispatchRemote({
      groupSegments: ["tasks"],
      command: "show",
      body: { taskId: "task-1" },
      config: getHomeGatewayConfig({ RAVI_HOME_GATEWAY_URL: homeUrl }),
      env: {},
      fetchImpl: (async () =>
        new Response("{}", {
          headers: { "content-type": "application/json", "content-length": String(HOME_RESPONSE_MAX_BYTES + 1) },
        })) as unknown as typeof fetch,
    }).catch((caught: unknown) => caught as { code?: string });
    expect((declared as { code?: string }).code).toBe("HOME_RESPONSE_TOO_LARGE");

    const atLimit = await dispatchRemote({
      groupSegments: ["tasks"],
      command: "show",
      body: { taskId: "task-1" },
      config: getHomeGatewayConfig({ RAVI_HOME_GATEWAY_URL: homeUrl }),
      env: {},
      fetchImpl: (async () =>
        new Response(new Uint8Array(HOME_RESPONSE_MAX_BYTES).fill(0x20), {
          headers: { "content-type": "text/plain" },
        })) as unknown as typeof fetch,
    });
    expect(atLimit.body.length).toBe(HOME_RESPONSE_MAX_BYTES);
  });
});
