import { describe, expect, it } from "bun:test";
import {
  classifyAnthropicSecretShape,
  describeResolvedSecretShapeMismatch,
  explainRuntimeCredentialProviderFailure,
  findRuntimeCredentialSecretShapeMismatch,
  isolateSelectedClaudeAuthEnv,
  RAVI_CLAUDE_MANAGED_AUTH_ENV,
} from "./credential-secret-shape.js";

describe("credential secret shape", () => {
  it("distinguishes Anthropic API keys from OAuth tokens and leaves other secrets unknown", () => {
    expect(classifyAnthropicSecretShape("sk-ant-api03-fake-not-a-real-key")).toBe("api-key");
    expect(classifyAnthropicSecretShape("sk-ant-fake-not-a-real-key")).toBe("api-key");
    expect(classifyAnthropicSecretShape("sk-ant-oat01-fake-oauth-token")).toBe("oauth");
    expect(classifyAnthropicSecretShape("test-daemon-token")).toBe("unknown");
    expect(classifyAnthropicSecretShape("sk-test_ready_secret_value")).toBe("unknown");
  });

  it("rejects an API key declared as Claude OAuth without echoing the secret", () => {
    const secret = "sk-ant-api03-fake-not-a-real-key";
    const mismatch = describeResolvedSecretShapeMismatch({
      label: "claude-oauth",
      authMethod: "claude-oauth",
      targetName: "CLAUDE_CODE_OAUTH_TOKEN",
      value: secret,
    });
    expect(mismatch?.expected).toBe("oauth");
    expect(mismatch?.detected).toBe("api-key");
    expect(mismatch?.message).toContain('Credential "claude-oauth" (claude-oauth)');
    expect(mismatch?.message).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(mismatch?.reason.startsWith("secret_shape_mismatch:")).toBe(true);
    expect(JSON.stringify(mismatch)).not.toContain(secret);
  });

  it("accepts an OAuth token in the OAuth slot and an API key in the API-key slot", () => {
    expect(
      describeResolvedSecretShapeMismatch({
        label: "claude-oauth",
        authMethod: "claude-oauth",
        targetName: "CLAUDE_CODE_OAUTH_TOKEN",
        value: "sk-ant-oat01-fake-oauth-token",
      }),
    ).toBeNull();
    expect(
      findRuntimeCredentialSecretShapeMismatch(
        {
          label: "anthropic-api",
          authMethod: "api-key",
          bindings: [
            {
              sourceKind: "env",
              targetKind: "env",
              targetName: "ANTHROPIC_API_KEY",
              secretRef: "env:ANTHROPIC_API_KEY",
            },
          ],
        },
        { ANTHROPIC_API_KEY: "sk-ant-api03-fake-not-a-real-key" },
      ),
    ).toBeNull();
  });

  it("names the credential when an OAuth selection hits provider billing noise", () => {
    const explained = explainRuntimeCredentialProviderFailure("Credit balance is too low", {
      label: "claude-oauth",
      authMethod: "claude-oauth",
    });
    expect(explained).toContain('Credential "claude-oauth" (claude-oauth)');
    expect(explained).toContain("Credit balance is too low");
    expect(explained.toLowerCase()).toContain("api key");
    expect(
      explainRuntimeCredentialProviderFailure("tool crashed", { label: "claude-oauth", authMethod: "claude-oauth" }),
    ).toBe("tool crashed");
  });

  it("blocks inherited process auth env when an auth profile is selected", () => {
    const runtimeEnv: Record<string, string> = {
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-api03-fake-not-a-real-key",
      ANTHROPIC_API_KEY: "sk-ant-api03-other-fake-key",
      CLAUDE_CONFIG_DIR: "/tmp/claude-profile",
      PATH: "/usr/bin",
    };
    const blocked = isolateSelectedClaudeAuthEnv({
      runtimeProviderId: "claude",
      binding: {
        authMethod: "claude-oauth",
        resolvedEnv: {},
      },
      runtimeEnv,
    });
    expect(blocked.sort()).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(runtimeEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(runtimeEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(runtimeEnv.CLAUDE_CONFIG_DIR).toBe("/tmp/claude-profile");
    expect(runtimeEnv[RAVI_CLAUDE_MANAGED_AUTH_ENV]).toBe("1");
    expect(runtimeEnv.PATH).toBe("/usr/bin");
  });

  it("keeps the selected credential secret and still blocks other inherited auth keys", () => {
    const runtimeEnv: Record<string, string> = {
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-selected",
      ANTHROPIC_API_KEY: "sk-ant-api03-inherited",
    };
    const blocked = isolateSelectedClaudeAuthEnv({
      runtimeProviderId: "claude",
      binding: {
        authMethod: "claude-oauth",
        resolvedEnv: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-selected" },
      },
      runtimeEnv,
    });
    expect(blocked).toEqual(["ANTHROPIC_API_KEY"]);
    expect(runtimeEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-selected");
    expect(runtimeEnv.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
