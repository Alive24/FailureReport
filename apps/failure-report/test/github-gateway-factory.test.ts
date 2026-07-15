import type { Octokit } from "octokit";
import { describe, expect, it, vi } from "vitest";

import {
  createGithubIssueGateway,
  readGithubGatewayRuntimeConfig,
} from "../integrations/github/gateway-factory.js";
import { OctokitIssueGateway } from "../integrations/github/octokit-issue-gateway.js";

describe("GitHub gateway runtime composition", () => {
  it("uses Octokit with the active gh credential by default", async () => {
    const config = readGithubGatewayRuntimeConfig({});
    const readGhToken = vi.fn().mockResolvedValue("test-gh-token");
    const createTokenOctokit = vi.fn().mockReturnValue(fakeOctokit());
    const createGithubCliGateway = vi.fn();

    const gateway = await createGithubIssueGateway(config, {
      readGhToken,
      createTokenOctokit,
      createGithubCliGateway,
    });

    expect(config).toMatchObject({
      transport: "octokit",
      auth: { kind: "gh-cli", executable: "gh" },
    });
    expect(gateway).toBeInstanceOf(OctokitIssueGateway);
    expect(readGhToken).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "gh-cli", executable: "gh" }),
    );
    expect(createTokenOctokit).toHaveBeenCalledOnce();
    expect(createGithubCliGateway).not.toHaveBeenCalled();
  });

  it("selects injected token authentication without invoking gh", async () => {
    const config = readGithubGatewayRuntimeConfig({
      FAILURE_REPORT_GITHUB_AUTH: "token",
      GITHUB_TOKEN: "test-injected-token",
    });
    const readGhToken = vi.fn();
    const createTokenOctokit = vi.fn().mockReturnValue(fakeOctokit());

    await createGithubIssueGateway(config, {
      readGhToken,
      createTokenOctokit,
    });

    expect(config.auth).toMatchObject({ kind: "token" });
    expect(readGhToken).not.toHaveBeenCalled();
    expect(createTokenOctokit).toHaveBeenCalledWith(
      expect.objectContaining({ auth: "test-injected-token" }),
    );
  });

  it("selects GitHub App installation authentication only when configured", async () => {
    const config = readGithubGatewayRuntimeConfig({
      FAILURE_REPORT_GITHUB_AUTH: "app",
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: "test-private-key",
      GITHUB_APP_INSTALLATION_ID: "67890",
    });
    const createInstallationOctokit = vi.fn().mockResolvedValue(fakeOctokit());
    const createTokenOctokit = vi.fn();

    const gateway = await createGithubIssueGateway(config, {
      createInstallationOctokit,
      createTokenOctokit,
    });

    expect(gateway).toBeInstanceOf(OctokitIssueGateway);
    expect(config.auth).toMatchObject({
      kind: "app",
      appId: "12345",
      installationId: 67890,
    });
    expect(createInstallationOctokit).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "12345", installationId: 67890 }),
    );
    expect(createTokenOctokit).not.toHaveBeenCalled();
  });

  it("keeps the gh api gateway as an explicit transport fallback", async () => {
    const config = readGithubGatewayRuntimeConfig({
      FAILURE_REPORT_GITHUB_GATEWAY: "gh-cli",
      FAILURE_REPORT_GH_EXECUTABLE: "fixture-gh",
      FAILURE_REPORT_GITHUB_AUTH: "token",
    });
    const fallback = {
      readIssue: vi.fn(),
      publishSharedContext: vi.fn(),
    };
    const createGithubCliGateway = vi.fn().mockReturnValue(fallback);

    const gateway = await createGithubIssueGateway(config, {
      createGithubCliGateway,
    });

    expect(gateway).toBe(fallback);
    expect(createGithubCliGateway).toHaveBeenCalledWith("fixture-gh");
  });
});

function fakeOctokit(): Octokit {
  return {
    rest: {
      issues: {
        get: vi.fn(),
        listComments: vi.fn(),
        update: vi.fn(),
        createComment: vi.fn(),
        updateComment: vi.fn(),
      },
    },
    paginate: vi.fn(),
  } as unknown as Octokit;
}
