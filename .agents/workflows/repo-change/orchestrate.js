const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
const instruction = typeof input.instruction === "string" ? input.instruction.trim() : "";

if (!instruction) throw new Error("repo-change requires instruction: string");

const normalizeStringArray = (value, field) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`repo-change ${field} must be a string array`);
  const result = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`repo-change ${field}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
  if (new Set(result).size !== result.length) {
    throw new Error(`repo-change ${field} must not contain duplicates`);
  }
  return result;
};

const acceptanceCriteria = normalizeStringArray(input.acceptanceCriteria, "acceptanceCriteria");
const validationCommands = normalizeStringArray(input.validationCommands, "validationCommands");
const stageOrder = ["scope", "implement", "review", "verify"];

const deliveryObject = (value, label) => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") throw new Error(`${label} returned no structured delivery`);
  const text = value
    .trim()
    .replace(/^```(?:json)?\s*/u, "")
    .replace(/\s*```$/u, "");
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // The stable failure below avoids treating narration as structured evidence.
  }
  throw new Error(`${label} returned non-JSON delivery`);
};

const verdictAccepted = (value) => {
  const verdict = String(value.verdict ?? value.status ?? "").toLowerCase();
  return ["accepted", "approved", "completed", "succeeded", "ready"].includes(verdict);
};

const reject = (failedStage, reason, evidence) => {
  stage(failedStage, { status: "fail" });
  const failedIndex = stageOrder.indexOf(failedStage);
  for (const skipped of stageOrder.slice(failedIndex + 1)) stage(skipped, { status: "skip" });
  return {
    status: "rejected",
    rejectedAt: failedStage,
    reason,
    evidence,
    publication: { performed: false },
  };
};

stage("scope");
const scope = deliveryObject(
  await agent(
    [
      "Scope this repository change before any implementation.",
      "Identify the authoritative owner, package/protocol/state boundaries, risks, and concrete acceptance boundary.",
      "Return JSON only with owner, boundaries, risks, acceptanceCriteria, verdict, and blockingReasons.",
      `Instruction: ${instruction}`,
      `Caller acceptance criteria: ${JSON.stringify(acceptanceCriteria)}`,
      `Requested validation commands: ${JSON.stringify(validationCommands)}`,
    ].join("\n"),
    { label: "architecture scope", role: "spark-architecture-guardian" },
  ),
  "architecture scope guardian",
);
if (!verdictAccepted(scope)) {
  return reject("scope", "architecture scope guardian rejected the change", { scope });
}
stage("scope", { status: "success" });

stage("implement");
const implementation = deliveryObject(
  await agent(
    [
      "Implement the bounded change in the current owning worktree.",
      "Do not create, push, merge, or publish a pull request.",
      "Run the requested validation commands and any focused tests needed by the owner.",
      "Return JSON only with status, summary, changedFiles, validationEvidence, acceptanceEvidence, and blockers.",
      `Instruction: ${instruction}`,
      `Acceptance criteria: ${JSON.stringify(acceptanceCriteria)}`,
      `Validation commands: ${JSON.stringify(validationCommands)}`,
      `Approved scope handoff: ${JSON.stringify(scope)}`,
    ].join("\n"),
    { label: "repository implementation", roleRef: "role:builtin-executor" },
  ),
  "repository executor",
);
if (!verdictAccepted(implementation)) {
  return reject("implement", "repository executor did not complete the bounded change", {
    scope,
    implementation,
  });
}
stage("implement", { status: "success" });

const changedFiles = Array.isArray(implementation.changedFiles)
  ? implementation.changedFiles.filter((value) => typeof value === "string")
  : [];
const knowledgeText = [instruction, ...acceptanceCriteria, ...changedFiles].join("\n");
const needsKnowledgeReview =
  changedFiles.some((file) => file === ".agents" || file.startsWith(".agents/")) ||
  /(?:^|[\s/])AGENTS\.md\b|Agent Notes?|\bRoles?\b|\bSkills?\b|\bWorkflows?\b/u.test(knowledgeText);

stage("review");
const reviewCalls = [
  () =>
    agent(
      [
        "Independently review the implemented diff against Spark package, owner, protocol, and compatibility boundaries.",
        "Do not trust implementation narration; inspect repository evidence.",
        "Return JSON only with verdict, findings, boundaryEvidence, and blockingReasons.",
        `Original instruction: ${instruction}`,
        `Scope handoff: ${JSON.stringify(scope)}`,
        `Implementation delivery: ${JSON.stringify(implementation)}`,
      ].join("\n"),
      { label: "architecture review", role: "spark-architecture-guardian" },
    ),
];
if (needsKnowledgeReview) {
  reviewCalls.push(() =>
    agent(
      [
        "Independently review the agent-knowledge portion of this change.",
        "Check one-home-per-fact, AGENTS/Notes/Role/Skill/Workflow classification, progressive disclosure, and duplication.",
        "Do not edit files. Return JSON only with verdict, classification, findings, validation, and blockers.",
        `Original instruction: ${instruction}`,
        `Scope handoff: ${JSON.stringify(scope)}`,
        `Implementation delivery: ${JSON.stringify(implementation)}`,
      ].join("\n"),
      { label: "agent knowledge review", role: "spark-agent-knowledge-curator" },
    ),
  );
}
const rawReviews = await parallel(reviewCalls, { concurrency: 2, onError: "fail-fast" });
const architectureReview = deliveryObject(rawReviews[0], "architecture review guardian");
const knowledgeReview = needsKnowledgeReview
  ? deliveryObject(rawReviews[1], "agent knowledge curator")
  : undefined;
if (
  !verdictAccepted(architectureReview) ||
  (knowledgeReview && !verdictAccepted(knowledgeReview))
) {
  return reject("review", "one or more independent guardians rejected the implemented change", {
    scope,
    implementation,
    architectureReview,
    knowledgeReview,
  });
}
stage("review", { status: "success" });

const validationEvidence = Array.isArray(implementation.validationEvidence)
  ? implementation.validationEvidence
  : [];
const passingCommands = new Set(
  validationEvidence.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const status = String(entry.status ?? entry.result ?? "").toLowerCase();
    return typeof entry.command === "string" && ["passed", "success", "succeeded"].includes(status)
      ? [entry.command.trim()]
      : [];
  }),
);
const missingValidationCommands = validationCommands.filter(
  (command) => !passingCommands.has(command),
);
const validationEvidenceMissing =
  validationEvidence.length === 0 || missingValidationCommands.length > 0;

stage("verify");
const verification = deliveryObject(
  await agent(
    [
      "Independently verify the current diff, validation evidence, and every acceptance criterion.",
      "Reject when evidence is missing, a command failed, the diff is unexplained, or PR readiness cannot be established.",
      "Do not publish Git state. Return JSON only with verdict, scopeMatch, diffFindings, validationEvidence, acceptanceCriteria, prReadiness, and blockingReasons.",
      `Original instruction: ${instruction}`,
      `Acceptance criteria: ${JSON.stringify(acceptanceCriteria)}`,
      `Required validation commands: ${JSON.stringify(validationCommands)}`,
      `Mechanically missing validation commands: ${JSON.stringify(missingValidationCommands)}`,
      `Scope handoff: ${JSON.stringify(scope)}`,
      `Implementation delivery: ${JSON.stringify(implementation)}`,
      `Architecture review: ${JSON.stringify(architectureReview)}`,
      `Agent knowledge review: ${JSON.stringify(knowledgeReview)}`,
    ].join("\n"),
    { label: "delivery verification", role: "spark-delivery-verifier" },
  ),
  "delivery verifier",
);
const verifiedAcceptance = Array.isArray(verification.acceptanceCriteria)
  ? verification.acceptanceCriteria
  : [];
const missingAcceptanceCriteria = acceptanceCriteria.filter(
  (criterion) =>
    !verifiedAcceptance.some((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const name = String(entry.criterion ?? entry.acceptanceCriterion ?? "").trim();
      const status = String(entry.status ?? entry.result ?? "").toLowerCase();
      return name === criterion && ["satisfied", "passed", "accepted", "success"].includes(status);
    }),
);
if (
  validationEvidenceMissing ||
  missingAcceptanceCriteria.length > 0 ||
  !verdictAccepted(verification)
) {
  return reject(
    "verify",
    "delivery verification, command evidence, or acceptance evidence is incomplete",
    {
      scope,
      implementation,
      architectureReview,
      knowledgeReview,
      verification,
      missingValidationCommands,
      missingAcceptanceCriteria,
    },
  );
}
stage("verify", { status: "success" });

return {
  status: "accepted",
  instruction,
  acceptanceCriteria,
  validationCommands,
  scope,
  implementation,
  reviews: {
    architecture: architectureReview,
    ...(knowledgeReview ? { agentKnowledge: knowledgeReview } : {}),
  },
  verification,
  publication: { performed: false },
};
