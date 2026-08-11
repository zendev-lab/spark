# Skill Agents

`skill_agent` is the canonical intelligent execution surface for one or more
model-invocable Skills. It lets the parent Agent hand off a self-contained unit
of work to one dedicated owner-bound Agent Session without interpreting those Skills as
its own operating procedure.

## Invocation

The public request is deliberately small:

```json
{
  "skills": ["release-audit", "github-publish"],
  "instruction": "Audit the release candidate and publish only when verification passes.",
  "inputs": ["package.json", "CI must pass"],
  "timeoutMs": 300000
}
```

- `skills` is the complete ordered set of one to eight exact discovered Skill
  names that jointly govern this invocation.
- Duplicate Skill names are rejected rather than loaded twice.
- `instruction` is self-contained because the Agent does not inherit the parent
  transcript.
- `inputs` is an optional bounded list of paths, refs, constraints, or compact
  context items.
- `timeoutMs` is bounded and does not make execution persistent.

The public tool is currently active only in the `implement` operating surface
because its Agent may execute commands or write files. The operating-mode
refactor will rename this surface to `execute`; a planning Session must not use
a write-capable Skill Agent to bypass its write boundary.

The tool rejects unknown, disabled, `disable-model-invocation`, duplicate, or
invalidly named Skills before starting an Agent. The combined Skill source is
size-bounded as one aggregate and is never silently truncated.

## Agent construction

Each accepted call creates one fresh owned Role Session:

- the dynamic Role ref is derived from the ordered Skill set;
- the Role uses semantic Model Type `implementation`; missing configuration
  fails with `role_model_type_unconfigured` and never inherits the parent model;
- `SessionSupervisor` owns the child lifecycle and discard-on-close retention;
- the system prompt names every selected Skill and contains every resolved Skill
  body, source path, and absolute base directory;
- all Skill bodies are loaded exactly once by the host before the child starts;
- completion returns bounded Agent output and run metadata to the parent.

A Skill Agent is an owned, non-restorable Spark Session. Closing it removes the
full transcript and Invocation payload after sealing a bounded receipt from
`role_report_outcome` and the final assistant result. If that semantic candidate
is absent or invalid, the daemon seals a deterministic fallback. Usage,
execution profile, the receipt, and explicit Evidence remain queryable. It does
not claim a Task or create Task attribution.

## Prompt contract

The child system prompt begins with the equivalent of:

```text
You are a dedicated Spark Agent for executing the following Skills:
release-audit, github-publish.

Complete the assigned task autonomously within the combined scope of these
Skills. Follow every applicable Skill instruction and the concrete task
instruction.

All selected Skill instructions are already included below. Do not search for,
read, reload, or delegate these Skills again.
```

It then embeds each complete Skill:

```xml
<skills>
  <skill>
    <name>release-audit</name>
    <source>/absolute/path/release-audit/SKILL.md</source>
    <base_dir>/absolute/path/release-audit</base_dir>
    <instructions>
      ...complete Skill body...
    </instructions>
  </skill>
</skills>
```

Applicable Skill instructions have equal authority. The Agent applies each
Skill to the part of the task it governs and reconciles compatible
instructions. If applicable instructions materially conflict and cannot all be
satisfied, it stops and reports the exact conflict upward instead of silently
choosing one.

## Authority boundary

The parent Agent owns decomposition, user intent, durable coordination,
consequential verification, publication, and user-facing synthesis. The Skill
Agent owns only the explicit assigned unit.

The child receives a fixed direct-work tool profile for bounded file search,
file mutation, execution, Web research, and context inspection. It cannot:

- ask the user or manage persistent Sessions;
- call Roles or another Skill Agent;
- dispatch or mutate Tasks;
- mutate Goal, Loop, Repro, or Workflow state;
- publish or manage Git, Artifact, Evidence, or Memory state.

A missing user decision or authorization is returned as an exact blocker to the
parent. Missing capability is not bypassed through another coordination
surface.

## Parent routing

The always-available Skill catalog contains only name, description, and path.
Request matching may add the first Markdown heading as bounded routing
metadata, but never injects a Skill body into the parent prompt.

When one or more Skills match, the parent chooses one primary path:

1. call `skill_agent` once with the complete matching Skill set when those
   Skills jointly own a self-contained unit of work;
2. use `read` only when the current Session itself must inspect and follow the
   Skill instructions.

The parent does not explicitly read selected Skills before calling
`skill_agent`, and it does not duplicate assigned work while the dedicated
Agent owns it.
