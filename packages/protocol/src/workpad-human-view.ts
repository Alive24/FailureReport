import type { FailureReport, FailureReportWorkpadEntry } from "./index.js";

const ordinaryCollectionLimit = 10;

/** Provider representation identity shown alongside the canonical entry identity. */
export type FailureReportWorkpadAuthority =
  | { kind: "inline" }
  | {
      kind: "manifest";
      group_id: string;
      payload_digest: string;
      chunk_count: number;
    };

/**
 * Renders the standalone human projection of one schema-validated workpad entry.
 *
 * Collection order is canonical report order. This function has no clock,
 * gateway, model, or previous-revision dependency.
 */
export function renderFailureReportWorkpadHumanView(
  entry: FailureReportWorkpadEntry,
  authority: FailureReportWorkpadAuthority = { kind: "inline" },
): string {
  const report = entry.report;
  const stage = workpadStage(report);
  const lines = [
    "### FailureReport update",
    "",
    ...renderIdentity(entry, authority, stage),
    "",
    "#### " + stage,
    "",
  ];

  if (stage === "Need Human Input") {
    lines.push(...renderHumanInput(report));
  } else if (stage === "Completed diagnosis") {
    lines.push(...renderCompletedDiagnosis(report));
  } else {
    lines.push(...renderActiveDiagnosis(report));
  }

  while (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.join("\n");
}

function workpadStage(
  report: FailureReport,
): "Active diagnosis" | "Need Human Input" | "Completed diagnosis" {
  if (report.handoff.human_input) {
    return "Need Human Input";
  }
  if (
    report.diagnostic_session?.lifecycle === "finalized" ||
    [
      "diagnosed",
      "todo_ready",
      "inconclusive",
      "blocked",
      "superseded",
    ].includes(report.status)
  ) {
    return "Completed diagnosis";
  }
  return "Active diagnosis";
}

function renderIdentity(
  entry: FailureReportWorkpadEntry,
  authority: FailureReportWorkpadAuthority,
  stage: string,
): string[] {
  const report = entry.report;
  const repositoryUrl = repositoryWebUrl(report.target.repository);
  const commitUrl =
    repositoryUrl + "/commit/" + encodeURIComponent(report.target.revision);
  const issue = report.shared_context;
  const lifecycle = report.diagnostic_session?.lifecycle ?? "not started";
  const lines = [
    "- Report: " + code(report.id),
    "- Stage: " + code(stage),
    "- Status: " + code(report.status),
    "- Severity: " + code(report.severity),
    "- Repository: " + markdownLink(report.target.repository, repositoryUrl),
    "- Immutable target revision: " +
      markdownLink(report.target.revision, commitUrl),
    "- Workpad revision: " + code(String(entry.revision)),
    "- Diagnostic session: " + code(lifecycle),
    "- Logical session: " + code(entry.logical_session_id),
    "- Authoritative entry: " + code(entry.entry_id),
  ];

  if (issue?.issue_url) {
    lines.push(
      "- Issue: " +
        markdownLink(
          issue.repository + "#" + String(issue.issue_number),
          issue.issue_url,
        ),
    );
  }
  if (report.diagnostic_session) {
    lines.push(
      "- Diagnostic session identity: " +
        code(report.diagnostic_session.worktree.identity),
    );
  }
  if (authority.kind === "manifest") {
    lines.push(
      "- Authoritative comment group: " + code(authority.group_id),
      "- Canonical payload digest: " + code(authority.payload_digest),
      "- Canonical chunks: " + code(String(authority.chunk_count)),
    );
  } else {
    lines.push("- Canonical representation: `inline folded snapshot`");
  }
  return lines;
}

function renderActiveDiagnosis(report: FailureReport): string[] {
  const sections = [
    renderCollectionSection(
      "Current facts and evidence",
      report.evidence.map(renderEvidence),
    ),
    renderCollectionSection(
      "Current hypotheses",
      report.hypotheses.map(
        (hypothesis) =>
          code(hypothesis.id) +
          " [" +
          plain(hypothesis.status) +
          "] — " +
          plain(hypothesis.statement),
      ),
    ),
    renderCollectionSection(
      "Experiments",
      report.experiments.map(renderExperiment),
    ),
    renderCollectionSection(
      "Remaining unknowns",
      report.conclusion.remaining_uncertainty.map(plain),
    ),
    renderCollectionSection(
      "Next diagnostic actions",
      report.experiments
        .filter(
          (experiment) =>
            experiment.outcome === "not_run" &&
            experiment.approval.status !== "rejected",
        )
        .map((experiment) => plain(experiment.proposed_action)),
    ),
  ];
  return joinSections(sections);
}

function renderHumanInput(report: FailureReport): string[] {
  const humanInput = report.handoff.human_input;
  if (!humanInput) {
    return [];
  }
  return joinSections([
    renderCollectionSection(
      "Confirmed facts",
      report.evidence
        .filter((evidence) =>
          ["observed", "verified"].includes(evidence.epistemic_status),
        )
        .map(renderEvidence),
    ),
    renderCollectionSection(
      "Completed or exhausted experiments",
      report.experiments.map(renderExperiment),
    ),
    renderCollectionSection(
      "Eliminated hypotheses",
      report.hypotheses
        .filter((hypothesis) => hypothesis.status === "rejected")
        .map(
          (hypothesis) =>
            code(hypothesis.id) + " — " + plain(hypothesis.statement),
        ),
    ),
    renderParagraphSection(
      "Remaining material unknown",
      humanInput.remaining_material_unknown,
    ),
    renderCollectionSection(
      "Viable options",
      humanInput.viable_options.map(plain),
      false,
    ),
    renderParagraphSection("Question", humanInput.question),
    renderParagraphSection("Resume condition", humanInput.resume_condition),
  ]);
}

function renderCompletedDiagnosis(report: FailureReport): string[] {
  const session = report.diagnostic_session;
  const snapshot = session?.diagnostic_branch;
  return joinSections([
    renderParagraphSection("Diagnosis", report.conclusion.diagnosis),
    renderParagraphSection(
      "Confidence",
      report.conclusion.confidence.level +
        " — " +
        report.conclusion.confidence.basis,
    ),
    renderCollectionSection(
      "Key evidence",
      report.evidence.map(renderEvidence),
    ),
    renderCollectionSection(
      "Remaining uncertainty",
      report.conclusion.remaining_uncertainty.map(plain),
    ),
    renderCollectionSection(
      "Residual risks",
      report.handoff.residual_risks.map(plain),
    ),
    renderCollectionSection(
      "Recommended remediation",
      report.conclusion.recommended_remediation.map(plain),
    ),
    snapshot
      ? [
          "##### Diagnostic snapshot",
          "",
          "- Branch: " +
            markdownLink(snapshot.name, snapshot.remote_url) +
            " (`diagnostic_snapshot_only`)",
          "- Immutable snapshot revision: " +
            markdownLink(snapshot.head_revision, snapshot.remote_url),
        ]
      : [],
  ]);
}

function renderEvidence(evidence: FailureReport["evidence"][number]): string {
  const publicArtifacts = evidence.artifacts
    .filter((artifact) => artifact.sensitivity === "public")
    .map((artifact) => safeExternalLink(artifact.ref))
    .filter((artifact): artifact is string => artifact !== undefined);
  const interpretation = evidence.interpretation
    ? " Interpretation: " + plain(evidence.interpretation)
    : "";
  const artifacts =
    publicArtifacts.length > 0
      ? " Public evidence: " + publicArtifacts.join(", ") + "."
      : "";
  return (
    code(evidence.id) +
    " [" +
    plain(evidence.epistemic_status) +
    "] — " +
    plain(evidence.observed_fact) +
    interpretation +
    artifacts
  );
}

function renderExperiment(
  experiment: FailureReport["experiments"][number],
): string {
  const interpretation = experiment.interpretation
    ? " Interpretation: " + plain(experiment.interpretation)
    : "";
  return (
    code(experiment.id) +
    " [" +
    plain(experiment.outcome) +
    "] — " +
    plain(experiment.question) +
    interpretation
  );
}

function renderCollectionSection(
  heading: string,
  items: readonly string[],
  bounded = true,
): string[] {
  if (items.length === 0) {
    return [];
  }
  const displayed = bounded ? items.slice(0, ordinaryCollectionLimit) : items;
  const lines = [
    "##### " + heading,
    "",
    ...displayed.map((item) => "- " + indentContinuation(item)),
  ];
  if (bounded && items.length > ordinaryCollectionLimit) {
    lines.push(
      "",
      "_" +
        String(items.length - ordinaryCollectionLimit) +
        " additional item" +
        (items.length - ordinaryCollectionLimit === 1 ? "" : "s") +
        " omitted; see Canonical context._",
    );
  }
  return lines;
}

function renderParagraphSection(heading: string, value: string): string[] {
  return ["##### " + heading, "", plain(value)];
}

function joinSections(sections: readonly string[][]): string[] {
  const nonEmpty = sections.filter((section) => section.length > 0);
  return nonEmpty.flatMap((section, index) =>
    index === nonEmpty.length - 1 ? section : [...section, ""],
  );
}

/** Escapes report-authored text without changing the persisted canonical value. */
function plain(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/\\/g, "&#92;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "@\u200b")
    .replace(/([`*_{}[\]()#+.!|~=-])/g, "\\$1")
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "<br>\n");
}

function code(value: string): string {
  return (
    "`" +
    value
      .replace(/&/g, "&amp;")
      .replace(/`/g, "&#96;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/@/g, "@\u200b")
      .replace(/\r?\n/g, " ") +
    "`"
  );
}

function indentContinuation(value: string): string {
  return value.replace(/\n/g, "\n  ");
}

function repositoryWebUrl(repository: string): string {
  return (
    "https://github.com/" +
    repository.split("/").map(encodeURIComponent).join("/")
  );
}

function markdownLink(label: string, url: string): string {
  const safe = normalizedHttpsUrl(url);
  return safe ? "[" + plain(label) + "](" + safe + ")" : plain(label);
}

function safeExternalLink(value: string): string | undefined {
  const safe = normalizedHttpsUrl(value);
  return safe ? "[" + plain(value) + "](" + safe + ")" : undefined;
}

function normalizedHttpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash.includes("\n")
    ) {
      return undefined;
    }
    return url.href
      .replace(/\(/g, "%28")
      .replace(/\)/g, "%29")
      .replace(/\\/g, "%5C");
  } catch {
    return undefined;
  }
}
