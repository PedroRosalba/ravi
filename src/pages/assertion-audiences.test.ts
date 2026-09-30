import { describe, expect, it } from "bun:test";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { describeAssertionAudienceSetRejection } from "./assertion-audiences.js";

describe("describeAssertionAudienceSetRejection", () => {
  it("forwards a safe Console hostname rejection with the Pages-host rule", () => {
    const rejection = describeAssertionAudienceSetRejection(
      new CloudAuthError("PAYLOAD_INVALID", "hostname must be this site's default or active custom hostname", {
        status: 400,
      }),
    );

    expect(rejection?.message).toContain("https origin of this Pages site");
    expect(rejection?.message).toContain("hostname must be this site's default or active custom hostname");
    expect(rejection?.suggestedAction).toContain("https://<site>.ravi.page");
  });

  it("scrubs credential URLs and still forwards the hostname sentence", () => {
    const rejection = describeAssertionAudienceSetRejection(
      new CloudAuthError(
        "PAYLOAD_INVALID",
        "hostname must be this site's default or active custom hostname: https://user:secret-token@api.example/private?token=value",
        { status: 400 },
      ),
    );

    expect(rejection?.message).toContain("hostname must be this site's default or active custom hostname");
    expect(rejection?.message).toContain("https://api.example");
    expect(rejection?.message).not.toContain("secret-token");
    expect(rejection?.message).not.toContain("user:");
    expect(rejection?.message).not.toContain("token=value");
  });

  it("uses the Pages-host rule when Console only returns the generic payload message", () => {
    const rejection = describeAssertionAudienceSetRejection(
      new CloudAuthError("PAYLOAD_INVALID", "Console request failed.", { status: 400 }),
    );

    expect(rejection?.message).toBe(
      "--origin must be an https origin of this Pages site (the default host or an active custom hostname). Put the API identifier in --aud.",
    );
    expect(rejection?.message).not.toContain("Console request failed");
  });

  it("forwards a safe non-origin 400 without rewriting it as an origin error", () => {
    const rejection = describeAssertionAudienceSetRejection(
      new CloudAuthError("PAYLOAD_INVALID", "Audience identifier is too long.", {
        status: 400,
        issues: [{ path: ["aud"], code: "too_big", message: "Audience identifier is too long." }],
      }),
    );

    expect(rejection?.message).toBe("Audience identifier is too long.");
    expect(rejection?.suggestedAction).toBe("correct the command input and retry");
    expect(rejection?.issues).toEqual([
      { path: ["aud"], code: "too_big", message: "Audience identifier is too long." },
    ]);
  });

  it("reads a hostname rejection from issues when the top-level message is generic", () => {
    const rejection = describeAssertionAudienceSetRejection(
      new CloudAuthError("PAYLOAD_INVALID", "Console request input was invalid.", {
        status: 400,
        issues: [
          {
            path: ["origins"],
            code: "invalid",
            message: "hostname must be this site's default or active custom hostname",
          },
        ],
      }),
    );

    expect(rejection?.message).toContain("hostname must be this site's default or active custom hostname");
    expect(rejection?.issues?.[0]?.message).toContain("hostname must be this site's default");
  });

  it("drops provider dumps and ignores statuses other than 400", () => {
    const dumped = describeAssertionAudienceSetRejection(
      new CloudAuthError("PAYLOAD_INVALID", "PRIVATE_PROVIDER_BODY_8K2R:PAYLOAD_INVALID", { status: 400 }),
    );
    expect(dumped?.message).toContain("this Pages site");
    expect(dumped?.message).not.toContain("PRIVATE_PROVIDER_BODY_8K2R");

    expect(
      describeAssertionAudienceSetRejection(
        new CloudAuthError("SERVER_UNAVAILABLE", "Console is down.", { status: 503 }),
      ),
    ).toBeNull();
    expect(
      describeAssertionAudienceSetRejection(
        new CloudAuthError("PAYLOAD_INVALID", "hostname must be this site's default or active custom hostname", {
          status: 422,
        }),
      ),
    ).toBeNull();
  });
});
