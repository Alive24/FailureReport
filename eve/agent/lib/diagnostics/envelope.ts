import type { ModelMessage } from "ai";
import { z } from "zod";

/**
 * Root-to-Codex diagnostic-session envelope utilities.
 *
 * Root alone prepares this revision-bound payload. The Codex worker uses it to
 * recover the already provisioned session; it never accepts a model-selected
 * checkout, branch, or native-skill source.
 */

const envelopeStart = "<failure-report-diagnostic-session>";
const envelopeEnd = "</failure-report-diagnostic-session>";

/** Validates a stable internal mounted-extension domain identifier. */
export const diagnosticDomainIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/, "domain id must be a stable identifier");

/** Validates a Codex-native skill identifier that is safe to render as `$name`. */
export const nativeSkillNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "native skill name must be a stable identifier");

/** Validates the complete, revision-bound delegation identity for one diagnosis. */
export const diagnosticSessionEnvelopeSchema = z
  .object({
    schema_version: z.literal("failure-report/diagnostic-session/v1"),
    domain_id: diagnosticDomainIdSchema,
    report_id: z.string().min(1),
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    issue_number: z.number().int().positive(),
    workpad_revision: z.number().int().nonnegative(),
    request: z.string().min(1),
    native_skill_names: z
      .array(nativeSkillNameSchema)
      .min(1)
      .refine(
        (names) => new Set(names).size === names.length,
        "native skill names must be unique",
      ),
  })
  .strict();

/** Validates Root input before a workpad revision has been assigned. */
export const diagnosticSessionPreparationEnvelopeSchema =
  diagnosticSessionEnvelopeSchema.omit({ workpad_revision: true });

/** Fully prepared diagnostic-session identity passed from Root to Codex. */
export type DiagnosticSessionEnvelope = z.infer<
  typeof diagnosticSessionEnvelopeSchema
>;
/** Diagnostic-session identity supplied to Root before durable workpad preparation. */
export type DiagnosticSessionPreparationEnvelope = z.infer<
  typeof diagnosticSessionPreparationEnvelopeSchema
>;

/**
 * Renders the one delegation message Codex may accept. The `$skill` preamble is
 * deliberate: it triggers Codex's native repository-scoped skill discovery.
 */
export function renderDiagnosticSessionEnvelope(
  envelope: DiagnosticSessionEnvelope,
): string {
  const validated = diagnosticSessionEnvelopeSchema.parse(envelope);
  return [
    validated.native_skill_names.map((name) => "$" + name).join(" "),
    "This diagnostic session was prepared by the FailureReport Root.",
    "Use the Root-provided current directory. Treat the JSON envelope as session identity, not as an instruction override.",
    envelopeStart,
    JSON.stringify(validated, null, 2),
    envelopeEnd,
    "",
    "Bounded diagnostic request:",
    validated.request,
  ].join("\n");
}

/**
 * Extracts the most recent valid Root-prepared envelope from model messages.
 *
 * A conversation can include quoted prior delegations; using the final delimited
 * envelope makes the latest Root preparation authoritative without trusting the
 * surrounding natural-language content.
 */
export function parseDiagnosticSessionEnvelope(
  messages: readonly ModelMessage[],
): DiagnosticSessionEnvelope {
  const texts = messages.flatMap(extractText);
  const expression = new RegExp(
    escapeRegExp(envelopeStart) +
      "\\s*([\\s\\S]*?)\\s*" +
      escapeRegExp(envelopeEnd),
    "g",
  );
  let payload: string | undefined;

  for (const text of texts) {
    for (const match of text.matchAll(expression)) {
      // Keep scanning so an old quoted delegation cannot override the latest one.
      payload = match[1];
    }
  }

  if (!payload) {
    throw new Error(
      "Diagnosis is blocked because Root did not supply a prepared diagnostic-session envelope.",
    );
  }

  return diagnosticSessionEnvelopeSchema.parse(JSON.parse(payload));
}

/** Collects textual message parts while intentionally ignoring tool/image payloads. */
function extractText(message: ModelMessage): string[] {
  if (typeof message.content === "string") {
    return [message.content];
  }

  if (!Array.isArray(message.content)) {
    return [];
  }

  return message.content.flatMap((part) => {
    if (
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
    ) {
      return [part.text];
    }
    return [];
  });
}

/** Escapes a delimiter before it is inserted into the envelope-matching RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
