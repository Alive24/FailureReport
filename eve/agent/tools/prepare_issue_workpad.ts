import { defineTool } from "eve/tools";
import { z } from "zod";

import { failureReportSchema } from "@failure-report/protocol";

import { readWorkpadProducerConfiguration } from "../lib/integrations/github/gateway-factory.js";
import {
  WorkpadNeedsInputError,
  prepareIssueWorkpadMutation,
} from "../lib/integrations/github/issue-workpad.js";

/**
 * Snapshot shape accepted by the side-effect-free workpad preparation tool.
 * It mirrors the gateway's read model rather than accepting arbitrary Issue JSON.
 */
const issueSnapshotSchema = z
  .object({
    repository: z.string().min(1),
    issue_number: z.number().int().positive(),
    title: z.string().min(1),
    issue_url: z.string().min(1),
    body: z.string(),
    updated_at: z.string().min(1),
    comments: z.array(
      z
        .object({
          id: z.string().min(1),
          body: z.string(),
          updated_at: z.string().min(1),
          author: z
            .object({
              id: z.string().min(1),
              login: z.string().min(1).optional(),
              type: z.string().min(1).optional(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * Prepares an owner-scoped, optimistic-concurrency-checked Issue workpad mutation
 * without publishing it. Producer configuration comes only from Root runtime
 * configuration, never from an untrusted tool caller.
 */
export default defineTool({
  description:
    "Prepare an append-only, provenance-checked GitHub Issue workpad mutation without publishing it.",
  inputSchema: z
    .object({
      issue: issueSnapshotSchema,
      report: failureReportSchema,
      synced_at: z.string().min(1),
    })
    .strict(),
  async execute(input) {
    try {
      const producers = readWorkpadProducerConfiguration();
      if (!producers) {
        throw new WorkpadNeedsInputError(
          "FailureReport workpad producer configuration is required before preparation.",
        );
      }
      return prepareIssueWorkpadMutation(
        input.issue,
        input.report,
        input.synced_at,
        producers,
      );
    } catch (error) {
      if (error instanceof WorkpadNeedsInputError) {
        return { status: "needs_input" as const, reason: error.message };
      }
      throw error;
    }
  },
});
