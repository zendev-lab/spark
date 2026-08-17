const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
const instruction = typeof input.instruction === "string" ? input.instruction.trim() : "";

if (!instruction) throw new Error("feature-change requires instruction: string");

const normalizeStringArray = (value, field) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`feature-change ${field} must be a string array`);
  const result = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`feature-change ${field}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
  if (new Set(result).size !== result.length) {
    throw new Error(`feature-change ${field} must not contain duplicates`);
  }
  return result;
};

const researchQuestions = normalizeStringArray(input.researchQuestions, "researchQuestions");
const constraints = normalizeStringArray(input.constraints, "constraints");
const acceptanceCriteria = normalizeStringArray(input.acceptanceCriteria, "acceptanceCriteria");
const validationCommands = normalizeStringArray(input.validationCommands, "validationCommands");

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
    // The stable failure below prevents narration from becoming evidence.
  }
  throw new Error(`${label} returned non-JSON delivery`);
};

const verdictAccepted = (value) => {
  const verdict = String(value.verdict ?? value.status ?? "").toLowerCase();
  return ["accepted", "approved", "completed", "succeeded", "ready"].includes(verdict);
};

const stageOrder = ["research", "select", "plan", "implement", "review", "verify"];
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

stage("research");
const research = deliveryObject(
  await agent(
    [
      "Research this feature from the live repository first, then resolve only external questions that can change the design.",
      "Separate facts, assumptions, constraints, open product decisions, and viable options. Do not select or implement yet.",
      "Return JSON only with problemEvidence, options, risks, outOfScope, openQuestions, verdict, and blockingReasons.",
      `Instruction: ${instruction}`,
      `Research questions: ${JSON.stringify(researchQuestions)}`,
      `Constraints: ${JSON.stringify(constraints)}`,
      `Caller acceptance criteria: ${JSON.stringify(acceptanceCriteria)}`,
    ].join("\n"),
    { label: "feature research", role: "spark-feature-planner" },
  ),
  "feature researcher",
);
if (!verdictAccepted(research)) {
  return reject("research", "feature research requires a decision or lacks evidence", { research });
}
stage("research", { status: "success" });

stage("select");
const selection = deliveryObject(
  await agent(
    [
      "Select the smallest viable owner-aligned feature design from the research handoff.",
      "Verify state ownership, package direction, protocol boundaries, authority, compatibility, and failure handling. Reject when a product choice is still missing.",
      "Return JSON only with owner, selection, rejectedOptions, surfaces, invariants, risks, acceptanceCriteria, outOfScope, verdict, and blockingReasons.",
      `Instruction: ${instruction}`,
      `Constraints: ${JSON.stringify(constraints)}`,
      `Caller acceptance criteria: ${JSON.stringify(acceptanceCriteria)}`,
      `Research handoff: ${JSON.stringify(research)}`,
    ].join("\n"),
    { label: "feature selection", role: "spark-architecture-guardian" },
  ),
  "architecture selector",
);
if (!verdictAccepted(selection)) {
  return reject("select", "architecture selection requires a decision or violates a boundary", {
    research,
    selection,
  });
}
stage("select", { status: "success" });

stage("plan");
const plan = deliveryObject(
  await agent(
    [
      "Turn the approved selection into a dependency-ordered implementation plan.",
      "Choose the smallest first slice that proves the highest-risk behavior and include failure, compatibility, documentation, and validation work. Do not implement.",
      "Return JSON only with plan, acceptanceCriteria, validationCommands, risks, outOfScope, openQuestions, verdict, and blockingReasons.",
      `Instruction: ${instruction}`,
      `Research handoff: ${JSON.stringify(research)}`,
      `Approved selection: ${JSON.stringify(selection)}`,
      `Caller acceptance criteria: ${JSON.stringify(acceptanceCriteria)}`,
      `Requested validation commands: ${JSON.stringify(validationCommands)}`,
    ].join("\n"),
    { label: "feature plan", role: "spark-feature-planner" },
  ),
  "feature planner",
);
if (!verdictAccepted(plan)) {
  return reject("plan", "feature planner could not produce an executable bounded plan", {
    research,
    selection,
    plan,
  });
}
stage("plan", { status: "success" });

const requiredAcceptanceCriteria = [
  ...new Set([
    ...acceptanceCriteria,
    ...normalizeStringArray(selection.acceptanceCriteria, "selection.acceptanceCriteria"),
    ...normalizeStringArray(plan.acceptanceCriteria, "plan.acceptanceCriteria"),
  ]),
];
const requiredValidationCommands = [
  ...new Set([
    ...validationCommands,
    ...normalizeStringArray(plan.validationCommands, "plan.validationCommands"),
  ]),
];

stage("implement");
const implementation = deliveryObject(
  await agent(
    [
      "Implement the approved feature plan in the current owning worktree.",
      "Do not broaden the selection, prebuild rejected options, or publish Git state.",
      "Run every requested validation command and focused owner tests.",
      "Return JSON only with status, summary, completedPlanItems, changedFiles, validationEvidence, acceptanceEvidence, and blockers.",
      `Instruction: ${instruction}`,
      `Approved selection: ${JSON.stringify(selection)}`,
      `Approved plan: ${JSON.stringify(plan)}`,
      `Acceptance criteria: ${JSON.stringify(requiredAcceptanceCriteria)}`,
      `Validation commands: ${JSON.stringify(requiredValidationCommands)}`,
    ].join("\n"),
    { label: "feature implementation", roleRef: "role:builtin-executor" },
  ),
  "feature executor",
);
if (!verdictAccepted(implementation)) {
  return reject("implement", "executor did not complete the approved feature plan", {
    research,
    selection,
    plan,
    implementation,
  });
}
stage("implement", { status: "success" });

const changedFiles = Array.isArray(implementation.changedFiles)
  ? implementation.changedFiles.filter((value) => typeof value === "string")
  : [];
const knowledgeText = [instruction, ...requiredAcceptanceCriteria, ...changedFiles].join("\n");
const needsKnowledgeReview =
  changedFiles.some((file) => file === ".agents" || file.startsWith(".agents/")) ||
  /(?:^|[\s/])AGENTS\.md\b|Agent Notes?|\bRoles?\b|\bSkills?\b|\bWorkflows?\b/u.test(knowledgeText);

stage("review");
const reviewCalls = [
  () =>
    agent(
      [
        "Independently review the actual feature diff against the approved owner, selection, compatibility, and acceptance boundary.",
        "Return JSON only with verdict, findings, boundaryEvidence, residualRisks, and blockingReasons.",
        `Selection: ${JSON.stringify(selection)}`,
        `Plan: ${JSON.stringify(plan)}`,
        `Implementation: ${JSON.stringify(implementation)}`,
      ].join("\n"),
      { label: "feature architecture review", role: "spark-architecture-guardian" },
    ),
  () =>
    agent(
      [
        "Independently review whether the feature is correct and whether every new structure has enough semantic payload to remain.",
        "Apply the deletion test and reject speculative scaffolding, duplicated semantics, parallel truth, and reconciliation-as-design.",
        "Return JSON only with verdict, findings, verifiedBehaviors, candidates, residualRisks, and blockingReasons.",
        `Selection: ${JSON.stringify(selection)}`,
        `Plan: ${JSON.stringify(plan)}`,
        `Implementation: ${JSON.stringify(implementation)}`,
      ].join("\n"),
      { label: "feature maintainability review", role: "spark-maintainability-reviewer" },
    ),
];
if (needsKnowledgeReview) {
  reviewCalls.push(() =>
    agent(
      [
        "Independently review the agent-knowledge portion for one-home-per-fact, correct classification, progressive disclosure, and duplication.",
        "Return JSON only with verdict, classification, findings, validation, and blockers.",
        `Implementation: ${JSON.stringify(implementation)}`,
      ].join("\n"),
      { label: "feature agent knowledge review", role: "spark-agent-knowledge-curator" },
    ),
  );
}
const rawReviews = await parallel(reviewCalls, {
  concurrency: reviewCalls.length,
  onError: "fail-fast",
});
const architectureReview = deliveryObject(rawReviews[0], "feature architecture review");
const maintainabilityReview = deliveryObject(rawReviews[1], "feature maintainability review");
const knowledgeReview = needsKnowledgeReview
  ? deliveryObject(rawReviews[2], "feature agent knowledge review")
  : undefined;
if (
  !verdictAccepted(architectureReview) ||
  !verdictAccepted(maintainabilityReview) ||
  (knowledgeReview && !verdictAccepted(knowledgeReview))
) {
  return reject("review", "one or more independent reviewers rejected the feature", {
    research,
    selection,
    plan,
    implementation,
    architectureReview,
    maintainabilityReview,
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
const missingValidationCommands = requiredValidationCommands.filter(
  (command) => !passingCommands.has(command),
);

stage("verify");
const verification = deliveryObject(
  await agent(
    [
      "Independently verify the feature diff, required command evidence, acceptance criteria, and pull-request readiness.",
      "Reject unexplained files, incomplete plan items, failed or missing commands, or acceptance claims without repository evidence. Do not publish Git state.",
      "Return JSON only with verdict, scopeMatch, diffFindings, validationEvidence, acceptanceCriteria, prReadiness, and blockingReasons.",
      `Instruction: ${instruction}`,
      `Acceptance criteria: ${JSON.stringify(requiredAcceptanceCriteria)}`,
      `Required validation commands: ${JSON.stringify(requiredValidationCommands)}`,
      `Mechanically missing validation commands: ${JSON.stringify(missingValidationCommands)}`,
      `Research: ${JSON.stringify(research)}`,
      `Selection: ${JSON.stringify(selection)}`,
      `Plan: ${JSON.stringify(plan)}`,
      `Implementation: ${JSON.stringify(implementation)}`,
      `Architecture review: ${JSON.stringify(architectureReview)}`,
      `Maintainability review: ${JSON.stringify(maintainabilityReview)}`,
      `Agent knowledge review: ${JSON.stringify(knowledgeReview)}`,
    ].join("\n"),
    { label: "feature verification", role: "spark-delivery-verifier" },
  ),
  "delivery verifier",
);
const verifiedAcceptance = Array.isArray(verification.acceptanceCriteria)
  ? verification.acceptanceCriteria
  : [];
const missingAcceptanceCriteria = requiredAcceptanceCriteria.filter(
  (criterion) =>
    !verifiedAcceptance.some((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const name = String(entry.criterion ?? entry.acceptanceCriterion ?? "").trim();
      const status = String(entry.status ?? entry.result ?? "").toLowerCase();
      return name === criterion && ["satisfied", "passed", "accepted", "success"].includes(status);
    }),
);
if (
  missingValidationCommands.length > 0 ||
  missingAcceptanceCriteria.length > 0 ||
  !verdictAccepted(verification)
) {
  return reject("verify", "delivery, validation, or acceptance evidence is incomplete", {
    research,
    selection,
    plan,
    implementation,
    architectureReview,
    maintainabilityReview,
    knowledgeReview,
    verification,
    missingValidationCommands,
    missingAcceptanceCriteria,
  });
}
stage("verify", { status: "success" });

return {
  status: "accepted",
  instruction,
  acceptanceCriteria: requiredAcceptanceCriteria,
  validationCommands: requiredValidationCommands,
  research,
  selection,
  plan,
  implementation,
  reviews: {
    architecture: architectureReview,
    maintainability: maintainabilityReview,
    ...(knowledgeReview ? { agentKnowledge: knowledgeReview } : {}),
  },
  verification,
  publication: { performed: false },
};
