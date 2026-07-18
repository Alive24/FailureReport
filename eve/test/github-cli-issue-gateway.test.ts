import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GithubCliIssueGateway } from "../agent/lib/integrations/github/github-cli.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** Ensures the explicit gh transport retains immutable comment-author identity. */
describe("GitHub CLI Issue gateway", () => {
  it("maps live comment author identities instead of relying on marker text or login", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "failure-report-gh-fixture-"),
    );
    temporaryPaths.push(directory);
    const executable = join(directory, "fixture-gh");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        'if [ "$2" = "--paginate" ]; then',
        '  printf \'%s\\n\' \'[{"id":10,"body":"Human comment","updated_at":"2026-07-15T10:00:01Z","user":{"id":777,"login":"human","type":"User"}},{"id":11,"body":"No author","updated_at":"2026-07-15T10:00:02Z","user":null}]\'',
        "else",
        '  printf \'%s\\n\' \'{"body":"# Human Issue body","html_url":"https://github.com/Alive24/CKBoost/issues/54","number":54,"updated_at":"2026-07-15T10:00:00Z"}\'',
        "fi",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(executable, 0o755);
    const gateway = new GithubCliIssueGateway(executable, {
      current: { id: "root-gh", github_actor_id: "101" },
      producers: [{ id: "root-gh", github_actor_id: "101" }],
    });

    const issue = await gateway.readIssue("Alive24/CKBoost", 54);

    expect(issue.body).toBe("# Human Issue body");
    expect(issue.comments).toEqual([
      {
        id: "10",
        body: "Human comment",
        updated_at: "2026-07-15T10:00:01Z",
        author: { id: "777", login: "human", type: "User" },
      },
      {
        id: "11",
        body: "No author",
        updated_at: "2026-07-15T10:00:02Z",
        author: null,
      },
    ]);
  });
});
