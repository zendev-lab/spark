const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
const instruction = typeof input.instruction === "string" ? input.instruction.trim() : "";

if (!instruction) throw new Error("maintainability-change requires instruction: string");

const normalizeStringArray = (value, field) => {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error(`maintainability-change ${field} must be a string array`);
  const result = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`maintainability-change ${field}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
  if (new Set(result).size !== result.length) {
    throw new Error(`maintainability-change ${field} must not contain duplicates`);
  }
  return result;
};

const target =
  typeof input.target === "string" && input.target.trim()
    ? input.target.trim()
    : "current worktree and diff";
const acceptanceCriteria = normalizeStringArray(input.acceptanceCriteria, "acceptanceCriteria");
const validationCommands = normalizeStringArray(input.validationCommands, "validationCommands");
const maxChanges = input.maxChanges === undefined ? 3 : Number(input.maxChanges);
if (!Number.isInteger(maxChanges) || maxChanges < 1 || maxChanges > 5) {
  throw new Error("maintainability-change maxChanges must be an integer from 1 to 5");
}

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

const stageOrder = ["scope", "review", "improve", "rereview", "verify"];
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
      "Establish the owner, observable behavior baseline, supported compatibility, and acceptance boundary before any maintainability edit.",
      "Reject when the target or equivalence boundary cannot be established from repository evidence.",
      "Return JSON only with owner, surfaces, invariants, risks, acceptanceCriteria, outOfScope, verdict, and blockingReasons.",
      `Instruction: ${instruction}`,
      `Target: ${target}`,
      `Caller acceptance criteria: ${JSON.stringify(acceptanceCriteria)}`,
      `Requested validation commands: ${JSON.stringify(validationCommands)}`,
    ].join("\n"),
    { label: "maintainability scope", role: "spark-architecture-guardian" },
  ),
  "architecture scope guardian",
);
if (!verdictAccepted(scope)) {
  return reject("scope", "architecture scope guardian rejected the maintainability boundary", {
    scope,
  });
}
stage("scope", { status: "success" });

stage("review");
const review = deliveryObject(
  await agent(
    [
      "Independently review the target for correctness and unnecessary complexity.",
      "Apply the deletion test, find the authoritative update path, and distinguish review findings from optional cleanup.",
      `Recommend at most ${maxChanges} independent slices, ordered by impact and proof cost. Do not edit files.`,
      "Return JSON only with findings, verifiedBehaviors, candidates, recommendedSlices, validationCommands, residualRisks, verdict, and blockingReasons.",
      `Instruction: ${instruction}`,
      `Target: ${target}`,
      `Approved scope: ${JSON.stringify(scope)}`,
    ].join("\n"),
    { label: "maintainability review", role: "spark-maintainability-reviewer" },
  ),
  "maintainability reviewer",
);
if (!verdictAccepted(review)) {
  return reject("review", "maintainability reviewer could not establish safe improvements", {
    scope,
    review,
  });
}
stage("review", { status: "success" });

const requiredAcceptanceCriteria = [
  ...new Set([
    ...acceptanceCriteria,
    ...normalizeStringArray(scope.acceptanceCriteria, "scope.acceptanceCriteria"),
  ]),
];
const requiredValidationCommands = [
  ...new Set([
    ...validationCommands,
    ...normalizeStringArray(review.validationCommands, "review.validationCommands"),
  ]),
];
const recommendedSlices = Array.isArray(review.recommendedSlices)
  ? review.recommendedSlices.slice(0, maxChanges)
  : [];
const needsExecutor = recommendedSlices.length > 0 || requiredValidationCommands.length > 0;
let implementation;
if (needsExecutor) {
  stage("improve");
  implementation = deliveryObject(
    await agent(
      [
        "Implement only the approved maintainability slices in the current owning worktree.",
        "Preserve observable behavior, ownership, serialization, and supported compatibility. Do not invent changes when the recommendation list is empty.",
        "Run every requested validation command and focused equivalence tests. Do not publish Git state.",
        "Return JSON only with status, summary, selectedSlices, changedFiles, validationEvidence, acceptanceEvidence, equivalenceEvidence, and blockers.",
        `Instruction: ${instruction}`,
        `Target: ${target}`,
        `Approved scope: ${JSON.stringify(scope)}`,
        `Selected slices: ${JSON.stringify(recommendedSlices)}`,
        `Acceptance criteria: ${JSON.stringify(requiredAcceptanceCriteria)}`,
        `Validation commands: ${JSON.stringify(requiredValidationCommands)}`,
      ].join("\n"),
      { label: "maintainability implementation", roleRef: "role:builtin-executor" },
    ),
    "maintainability executor",
  );
  if (!verdictAccepted(implementation)) {
    return reject("improve", "executor did not complete the bounded maintainability change", {
      scope,
      review,
      implementation,
    });
  }
  stage("improve", { status: "success" });
} else {
  stage("improve", { status: "skip" });
}

const changedFiles = Array.isArray(implementation?.changedFiles)
  ? implementation.changedFiles.filter((value) => typeof value === "string")
  : [];
let architectureReview;
let maintainabilityRereview;
let knowledgeReview;
if (changedFiles.length > 0) {
  stage("rereview");
  const calls = [
    () =>
      agent(
        [
          "Independently verify the implemented diff against the approved owner and behavior baseline.",
          "Return JSON only with verdict, findings, boundaryEvidence, residualRisks, and blockingReasons.",
          `Scope: ${JSON.stringify(scope)}`,
          `Initial review: ${JSON.stringify(review)}`,
          `Implementation: ${JSON.stringify(implementation)}`,
        ].join("\n"),
        { label: "maintainability architecture rereview", role: "spark-architecture-guardian" },
      ),
    () =>
      agent(
        [
          "Rerun correctness, deletion, and simplification review on the actual implemented diff.",
          "Reject replacement abstractions, new parallel truth, or missing equivalence evidence.",
          "Return JSON only with verdict, findings, verifiedBehaviors, remainingCandidates, residualRisks, and blockingReasons.",
          `Scope: ${JSON.stringify(scope)}`,
          `Initial review: ${JSON.stringify(review)}`,
          `Implementation: ${JSON.stringify(implementation)}`,
        ].join("\n"),
        { label: "maintainability complexity rereview", role: "spark-maintainability-reviewer" },
      ),
  ];
  const knowledgeText = [instruction, ...requiredAcceptanceCriteria, ...changedFiles].join("\n");
  const needsKnowledgeReview =
    changedFiles.some((file) => file === ".agents" || file.startsWith(".agents/")) ||
    /(?:^|[\s/])AGENTS\.md\b|Agent Notes?|\bRoles?\b|\bSkills?\b|\bWorkflows?\b/u.test(
      knowledgeText,
    );
  if (needsKnowledgeReview) {
    calls.push(() =>
      agent(
        [
          "Independently review the agent-knowledge portion for one-home-per-fact, correct classification, progressive disclosure, and duplication.",
          "Return JSON only with verdict, classification, findings, validation, and blockers.",
          `Implementation: ${JSON.stringify(implementation)}`,
        ].join("\n"),
        { label: "maintainability knowledge rereview", role: "spark-agent-knowledge-curator" },
      ),
    );
  }
  const rawReviews = await parallel(calls, { concurrency: calls.length, onError: "fail-fast" });
  architectureReview = deliveryObject(rawReviews[0], "architecture rereview");
  maintainabilityRereview = deliveryObject(rawReviews[1], "maintainability rereview");
  knowledgeReview = needsKnowledgeReview
    ? deliveryObject(rawReviews[2], "agent knowledge rereview")
    : undefined;
  if (
    !verdictAccepted(architectureReview) ||
    !verdictAccepted(maintainabilityRereview) ||
    (knowledgeReview && !verdictAccepted(knowledgeReview))
  ) {
    return reject("rereview", "one or more independent reviewers rejected the change", {
      scope,
      review,
      implementation,
      architectureReview,
      maintainabilityRereview,
      knowledgeReview,
    });
  }
  stage("rereview", { status: "success" });
} else {
  stage("rereview", { status: "skip" });
}

const validationEvidence = Array.isArray(implementation?.validationEvidence)
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
      "Independently verify the completed maintainability pass, required command evidence, acceptance criteria, and equivalence claims.",
      "A review-only pass with no safe candidate may succeed when the baseline and review evidence are complete. Never publish Git state.",
      "Return JSON only with verdict, scopeMatch, diffFindings, validationEvidence, acceptanceCriteria, equivalence, prReadiness, and blockingReasons.",
      `Instruction: ${instruction}`,
      `Acceptance criteria: ${JSON.stringify(requiredAcceptanceCriteria)}`,
      `Required validation commands: ${JSON.stringify(requiredValidationCommands)}`,
      `Mechanically missing validation commands: ${JSON.stringify(missingValidationCommands)}`,
      `Scope: ${JSON.stringify(scope)}`,
      `Initial review: ${JSON.stringify(review)}`,
      `Implementation: ${JSON.stringify(implementation)}`,
      `Architecture rereview: ${JSON.stringify(architectureReview)}`,
      `Maintainability rereview: ${JSON.stringify(maintainabilityRereview)}`,
      `Agent knowledge rereview: ${JSON.stringify(knowledgeReview)}`,
    ].join("\n"),
    { label: "maintainability verification", role: "spark-delivery-verifier" },
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
  return reject(
    "verify",
    "delivery, validation, acceptance, or equivalence evidence is incomplete",
    {
      scope,
      review,
      implementation,
      architectureReview,
      maintainabilityRereview,
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
  target,
  acceptanceCriteria: requiredAcceptanceCriteria,
  validationCommands: requiredValidationCommands,
  scope,
  review,
  selectedSlices: recommendedSlices,
  implementation,
  rereviews: {
    architecture: architectureReview,
    maintainability: maintainabilityRereview,
    ...(knowledgeReview ? { agentKnowledge: knowledgeReview } : {}),
  },
  verification,
  publication: { performed: false },
};
