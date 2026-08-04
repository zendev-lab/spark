# Skill delegation

`skill_delegate` is the canonical intelligent execution surface for one
model-invocable Skill. It lets the parent Agent delegate a self-contained unit
of work without interpreting the Skill as its own operating procedure.

## Invocation

The public request is deliberately small:

```json
{
  "skill": "release-audit",
  "instruction": "Audit the release candidate and report blockers.",
  "inputs": ["package.json", "CI must pass"],
  "timeoutMs": 30000
}
```

- `skill` is an exact discovered Skill name.
- `instruction` is self-contained because the Worker does not inherit the
  parent transcript.
- `inputs` is an optional bounded list of paths, refs, constraints, or compact
  context items.
- `timeoutMs` is bounded and does not make execution persistent.

The tool rejects unknown, disabled, or `disable-model-invocation` Skills before
starting a Worker. Skill source is size-bounded and never silently truncated.

## Worker lifecycle

Each accepted call creates one fresh anonymous Role run:

- the dynamic Role ref is `role:skill-<skill-name>`;
- the run inherits the active parent model;
- the run is `fresh`, `noSession`, and has anonymous persistence;
- the system prompt contains the resolved Skill body and its absolute base
  directory for relative references;
- completion returns the bounded Worker output and run metadata to the parent.

A Skill Worker is not a persistent Spark Session and cannot be resumed through
`session`. Direct Skill delegation does not claim a Task or create Task
attribution.

## Authority boundary

The parent Agent owns decomposition, user intent, durable coordination,
consequential verification, and user-facing synthesis. The Worker owns only the
explicit delegated unit.

The Worker receives a fixed direct-work tool profile for bounded file search,
file mutation, execution, Web research, and context inspection. It cannot:

- ask the user or manage persistent Sessions;
- call Roles, delegate another Skill, or dispatch Tasks;
- mutate Task, Goal, Loop, or Workflow state;
- publish or manage Git, Artifact, Evidence, or Memory state.

Host activation, phase, effect, and approval policy may further reduce the
available tools. Missing capability is reported as an exact blocker rather
than bypassed through another coordination surface.

## Prompt contract

The Skill catalog advertises two primary paths when a Skill matches:

1. call `skill_delegate` when one Skill can own a self-contained unit of work;
2. use `read` when the parent session itself must inspect and follow
   `SKILL.md`.

The parent should not explicitly read and delegate the same Skill by default,
and must not duplicate delegated work while the Worker owns it.
