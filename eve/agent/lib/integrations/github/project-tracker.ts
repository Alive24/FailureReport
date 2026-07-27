import type { Octokit } from "octokit";
import { z } from "zod";

import {
  createAuthenticatedOctokit,
  readGithubAuthConfig,
  type GithubAuthenticationDependencies,
} from "./github-auth.js";
import { WorkpadNeedsInputError } from "./issue-workpad.js";

/** Deployment-selected GitHub Project v2 coordinates; never accepted from Root input. */
export type GithubProjectTrackerCoordinates = {
  project_owner: string;
  project_owner_type: "organization" | "user";
  project_number: number;
  status_field: string;
};

/** Verified status transition after GitHub Project readback. */
export type GithubProjectTrackerTransition = {
  item_id: string;
  previous_state: string | null;
  state: string;
};

/** Narrow tracker port shared by intake and handoff delivery. */
export interface GithubProjectTracker {
  setIssueState(input: {
    repository: string;
    issue_number: number;
    tracker: GithubProjectTrackerCoordinates;
    state: string;
    allowed_previous_states?: readonly (string | null)[];
  }): Promise<GithubProjectTrackerTransition>;
}

const projectContextSchema = z
  .object({
    repository: z
      .object({
        issue: z
          .object({
            id: z.string().min(1),
            projectItems: z
              .object({
                pageInfo: z
                  .object({
                    hasNextPage: z.boolean(),
                  })
                  .strict(),
                nodes: z.array(
                  z
                    .object({
                      id: z.string().min(1),
                      project: z
                        .object({
                          id: z.string().min(1),
                        })
                        .strict(),
                    })
                    .strict(),
                ),
              })
              .strict(),
          })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
    projectOwner: z
      .object({
        projectV2: z
          .object({
            id: z.string().min(1),
            fields: z
              .object({
                pageInfo: z
                  .object({
                    hasNextPage: z.boolean(),
                  })
                  .strict(),
                nodes: z.array(z.unknown()),
              })
              .strict(),
          })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const singleSelectFieldSchema = z
  .object({
    __typename: z.literal("ProjectV2SingleSelectField"),
    id: z.string().min(1),
    name: z.string().min(1),
    options: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
        })
        .strict(),
    ),
  })
  .passthrough();

const itemStatusSchema = z
  .object({
    node: z
      .object({
        id: z.string().min(1),
        fieldValueByName: z
          .object({
            __typename: z.literal("ProjectV2ItemFieldSingleSelectValue"),
            name: z.string().min(1),
            optionId: z.string().min(1),
          })
          .passthrough()
          .nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const updatedItemStatusSchema = z
  .object({
    updateProjectV2ItemFieldValue: z
      .object({
        projectV2Item: z
          .object({
            id: z.string().min(1),
            fieldValueByName: z
              .object({
                __typename: z.literal("ProjectV2ItemFieldSingleSelectValue"),
                name: z.string().min(1),
                optionId: z.string().min(1),
              })
              .passthrough()
              .nullable(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

/**
 * GitHub GraphQL implementation with an add-if-missing item path and mandatory
 * status readback. The desired state is resolved by exact configured option
 * name, so a missing `Failure Report`, `Backlog`, or `Todo` option fails closed.
 */
export class OctokitGithubProjectTracker implements GithubProjectTracker {
  constructor(private readonly octokit: Octokit) {}

  async setIssueState(input: {
    repository: string;
    issue_number: number;
    tracker: GithubProjectTrackerCoordinates;
    state: string;
    allowed_previous_states?: readonly (string | null)[];
  }): Promise<GithubProjectTrackerTransition> {
    const context = await this.readContext(input);
    const issue = context.repository?.issue;
    const project = context.projectOwner?.projectV2;
    if (!issue) {
      throw new WorkpadNeedsInputError(
        "Configured tracker could not resolve the target GitHub Issue.",
      );
    }
    if (!project) {
      throw new WorkpadNeedsInputError(
        "Configured GitHub Project v2 could not be resolved with the active credentials.",
      );
    }
    if (
      issue.projectItems.pageInfo.hasNextPage ||
      project.fields.pageInfo.hasNextPage
    ) {
      throw new WorkpadNeedsInputError(
        "Configured tracker lookup exceeded its bounded Project context and requires operator narrowing.",
      );
    }
    const fields = project.fields.nodes.flatMap((candidate) => {
      const parsed = singleSelectFieldSchema.safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    });
    const matchingFields = fields.filter(
      (field) => field.name === input.tracker.status_field,
    );
    if (matchingFields.length !== 1) {
      throw new WorkpadNeedsInputError(
        "Configured tracker status field is missing or ambiguous.",
      );
    }
    const field = matchingFields[0];
    if (!field) {
      throw new WorkpadNeedsInputError(
        "Configured tracker status field could not be selected.",
      );
    }
    const matchingOptions = field.options.filter(
      (option) => option.name === input.state,
    );
    if (matchingOptions.length !== 1 || !matchingOptions[0]) {
      throw new WorkpadNeedsInputError(
        `Configured tracker requires exactly one "${input.state}" status option.`,
      );
    }

    const matchingItems = issue.projectItems.nodes.filter(
      (item) => item.project.id === project.id,
    );
    if (matchingItems.length > 1) {
      throw new WorkpadNeedsInputError(
        "Target Issue has multiple items in the configured GitHub Project.",
      );
    }
    const itemId =
      matchingItems[0]?.id ??
      (await this.addIssueToProject(project.id, issue.id));
    const previous = await this.readItemState(
      itemId,
      input.tracker.status_field,
    );
    if (
      input.allowed_previous_states &&
      !input.allowed_previous_states.includes(previous)
    ) {
      throw new WorkpadNeedsInputError(
        `GitHub Project item is currently "${previous ?? "unset"}"; FailureReport will not overwrite an active downstream state.`,
      );
    }
    if (previous === input.state) {
      return {
        item_id: itemId,
        previous_state: previous,
        state: input.state,
      };
    }

    const mutation = await this.octokit.graphql(
      `mutation UpdateFailureReportProjectStatus(
        $projectId: ID!
        $itemId: ID!
        $fieldId: ID!
        $optionId: String!
        $fieldName: String!
      ) {
        updateProjectV2ItemFieldValue(
          input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: { singleSelectOptionId: $optionId }
          }
        ) {
          projectV2Item {
            id
            fieldValueByName(name: $fieldName) {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                optionId
              }
            }
          }
        }
      }`,
      {
        projectId: project.id,
        itemId,
        fieldId: field.id,
        optionId: matchingOptions[0].id,
        fieldName: input.tracker.status_field,
      },
    );

    const readback =
      updatedItemStatusSchema.parse(mutation).updateProjectV2ItemFieldValue
        .projectV2Item.fieldValueByName?.name ?? null;
    if (readback !== input.state) {
      throw new WorkpadNeedsInputError(
        "GitHub Project status mutation did not produce the configured state on readback.",
      );
    }
    return {
      item_id: itemId,
      previous_state: previous,
      state: readback,
    };
  }

  private async readContext(input: {
    repository: string;
    issue_number: number;
    tracker: GithubProjectTrackerCoordinates;
  }): Promise<z.infer<typeof projectContextSchema>> {
    const [repositoryOwner, repositoryName, extra] =
      input.repository.split("/");
    if (!repositoryOwner || !repositoryName || extra) {
      throw new WorkpadNeedsInputError(
        "GitHub repository must use the owner/repository form.",
      );
    }
    const ownerField =
      input.tracker.project_owner_type === "organization"
        ? "organization"
        : "user";
    const response = await this.octokit.graphql(
      `query FailureReportProjectContext(
        $repositoryOwner: String!
        $repositoryName: String!
        $issueNumber: Int!
        $projectOwner: String!
        $projectNumber: Int!
      ) {
        repository(owner: $repositoryOwner, name: $repositoryName) {
          issue(number: $issueNumber) {
            id
            projectItems(first: 100) {
              pageInfo { hasNextPage }
              nodes {
                id
                project { id }
              }
            }
          }
        }
        projectOwner: ${ownerField}(login: $projectOwner) {
          projectV2(number: $projectNumber) {
            id
            fields(first: 100) {
              pageInfo { hasNextPage }
              nodes {
                __typename
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options { id name }
                }
              }
            }
          }
        }
      }`,
      {
        repositoryOwner,
        repositoryName,
        issueNumber: input.issue_number,
        projectOwner: input.tracker.project_owner,
        projectNumber: input.tracker.project_number,
      },
    );
    return projectContextSchema.parse(response);
  }

  private async addIssueToProject(
    projectId: string,
    issueId: string,
  ): Promise<string> {
    const response = await this.octokit.graphql(
      `mutation AddFailureReportIssueToProject(
        $projectId: ID!
        $contentId: ID!
      ) {
        addProjectV2ItemById(
          input: { projectId: $projectId, contentId: $contentId }
        ) {
          item { id }
        }
      }`,
      { projectId, contentId: issueId },
    );
    const parsed = z
      .object({
        addProjectV2ItemById: z
          .object({
            item: z.object({ id: z.string().min(1) }).strict(),
          })
          .strict(),
      })
      .strict()
      .parse(response);
    return parsed.addProjectV2ItemById.item.id;
  }

  private async readItemState(
    itemId: string,
    fieldName: string,
  ): Promise<string | null> {
    const response = await this.octokit.graphql(
      `query FailureReportProjectItemStatus(
        $itemId: ID!
        $fieldName: String!
      ) {
        node(id: $itemId) {
          ... on ProjectV2Item {
            id
            fieldValueByName(name: $fieldName) {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                optionId
              }
            }
          }
        }
      }`,
      { itemId, fieldName },
    );
    return (
      itemStatusSchema.parse(response).node?.fieldValueByName?.name ?? null
    );
  }
}

export type GithubProjectTrackerFactoryDependencies =
  GithubAuthenticationDependencies & {
    createTracker?: (octokit: Octokit) => GithubProjectTracker;
  };

/** Creates tracker transport from the same runtime-only GitHub auth policy. */
export async function createGithubProjectTracker(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: GithubProjectTrackerFactoryDependencies = {},
): Promise<GithubProjectTracker> {
  const octokit = await createAuthenticatedOctokit(
    readGithubAuthConfig(environment),
    dependencies,
  );
  return (
    dependencies.createTracker ??
    ((client) => new OctokitGithubProjectTracker(client))
  )(octokit);
}

let defaultTrackerPromise: Promise<GithubProjectTracker> | undefined;

/** One lazy Project client per process, reset after failed credential startup. */
export function getDefaultGithubProjectTracker(): Promise<GithubProjectTracker> {
  if (!defaultTrackerPromise) {
    const pending = createGithubProjectTracker();
    defaultTrackerPromise = pending;
    void pending.catch(() => {
      if (defaultTrackerPromise === pending) {
        defaultTrackerPromise = undefined;
      }
    });
  }
  return defaultTrackerPromise;
}
