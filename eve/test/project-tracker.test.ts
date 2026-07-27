import type { Octokit } from "octokit";
import { describe, expect, it, vi } from "vitest";

import { OctokitGithubProjectTracker } from "../agent/lib/integrations/github/project-tracker.js";

const trackerCoordinates = {
  project_owner: "Alive24",
  project_owner_type: "user" as const,
  project_number: 10,
  status_field: "Status",
};

function context(
  options: {
    currentItem?: boolean;
    states?: readonly string[];
  } = {},
) {
  return {
    repository: {
      issue: {
        id: "ISSUE_56",
        projectItems: {
          pageInfo: { hasNextPage: false },
          nodes:
            options.currentItem === false
              ? []
              : [{ id: "ITEM_56", project: { id: "PROJECT_10" } }],
        },
      },
    },
    projectOwner: {
      projectV2: {
        id: "PROJECT_10",
        fields: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              __typename: "ProjectV2SingleSelectField",
              id: "STATUS_FIELD",
              name: "Status",
              options: (
                options.states ?? ["Failure Report", "Backlog", "Todo"]
              ).map((name, index) => ({
                id: `OPTION_${index}`,
                name,
              })),
            },
          ],
        },
      },
    },
  };
}

function itemState(name: string | null) {
  return {
    node: {
      id: "ITEM_56",
      fieldValueByName: name
        ? {
            __typename: "ProjectV2ItemFieldSingleSelectValue",
            name,
            optionId: `OPTION_${name}`,
          }
        : null,
    },
  };
}

describe("GitHub Project v2 tracker", () => {
  it("moves an existing item to the configured state and requires readback", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(context())
      .mockResolvedValueOnce(itemState("Failure Report"))
      .mockResolvedValueOnce({
        updateProjectV2ItemFieldValue: {
          projectV2Item: {
            id: "ITEM_56",
            fieldValueByName: itemState("Todo").node.fieldValueByName,
          },
        },
      });
    const tracker = new OctokitGithubProjectTracker({
      graphql,
    } as unknown as Octokit);

    await expect(
      tracker.setIssueState({
        repository: "Alive24/CKBoost",
        issue_number: 56,
        tracker: trackerCoordinates,
        state: "Todo",
        allowed_previous_states: ["Failure Report", "Todo"],
      }),
    ).resolves.toEqual({
      item_id: "ITEM_56",
      previous_state: "Failure Report",
      state: "Todo",
    });
    expect(graphql).toHaveBeenCalledTimes(3);
    expect(graphql.mock.calls[2]?.[1]).toMatchObject({
      projectId: "PROJECT_10",
      itemId: "ITEM_56",
      fieldId: "STATUS_FIELD",
      optionId: "OPTION_2",
      fieldName: "Status",
    });
  });

  it("adds a missing Project item before setting its status", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(context({ currentItem: false }))
      .mockResolvedValueOnce({
        addProjectV2ItemById: { item: { id: "ITEM_56" } },
      })
      .mockResolvedValueOnce(itemState(null))
      .mockResolvedValueOnce({
        updateProjectV2ItemFieldValue: {
          projectV2Item: {
            id: "ITEM_56",
            fieldValueByName: itemState("Failure Report").node.fieldValueByName,
          },
        },
      });
    const tracker = new OctokitGithubProjectTracker({
      graphql,
    } as unknown as Octokit);

    await expect(
      tracker.setIssueState({
        repository: "Alive24/CKBoost",
        issue_number: 56,
        tracker: trackerCoordinates,
        state: "Failure Report",
        allowed_previous_states: [null],
      }),
    ).resolves.toMatchObject({
      previous_state: null,
      state: "Failure Report",
    });
    expect(graphql.mock.calls[1]?.[1]).toEqual({
      projectId: "PROJECT_10",
      contentId: "ISSUE_56",
    });
  });

  it("is idempotent and refuses an active downstream state before mutation", async () => {
    const idempotentGraphql = vi
      .fn()
      .mockResolvedValueOnce(context())
      .mockResolvedValueOnce(itemState("Todo"));
    const idempotent = new OctokitGithubProjectTracker({
      graphql: idempotentGraphql,
    } as unknown as Octokit);

    await expect(
      idempotent.setIssueState({
        repository: "Alive24/CKBoost",
        issue_number: 56,
        tracker: trackerCoordinates,
        state: "Todo",
        allowed_previous_states: ["Failure Report", "Todo"],
      }),
    ).resolves.toMatchObject({ previous_state: "Todo", state: "Todo" });
    expect(idempotentGraphql).toHaveBeenCalledTimes(2);

    const guardedGraphql = vi
      .fn()
      .mockResolvedValueOnce(context())
      .mockResolvedValueOnce(itemState("In Progress"));
    const guarded = new OctokitGithubProjectTracker({
      graphql: guardedGraphql,
    } as unknown as Octokit);
    await expect(
      guarded.setIssueState({
        repository: "Alive24/CKBoost",
        issue_number: 56,
        tracker: trackerCoordinates,
        state: "Failure Report",
        allowed_previous_states: [null, "Backlog", "Todo"],
      }),
    ).rejects.toThrow("will not overwrite an active downstream state");
    expect(guardedGraphql).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the tracker does not define Failure Report", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        context({ states: ["Backlog", "Todo", "Human Review"] }),
      );
    const tracker = new OctokitGithubProjectTracker({
      graphql,
    } as unknown as Octokit);

    await expect(
      tracker.setIssueState({
        repository: "Alive24/CKBoost",
        issue_number: 56,
        tracker: trackerCoordinates,
        state: "Failure Report",
      }),
    ).rejects.toThrow('exactly one "Failure Report" status option');
    expect(graphql).toHaveBeenCalledTimes(1);
  });
});
