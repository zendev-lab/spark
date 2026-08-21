import { describe, expect, it } from "vitest";

import { compileCueFile, compileExecution } from "./execution-compiler.ts";

describe("Cue execution compiler", () => {
  it("keeps leading assignments local to each pipeline segment", () => {
    expect(compileExecution("A=one B=two printf ok |> A=three cat").plan).toEqual({
      kind: "pipeline",
      pipeline: {
        segments: [
          {
            env: { A: "one", B: "two" },
            command: ["printf", "ok"],
            pipe_to_next: "Stdout",
          },
          { env: { A: "three" }, command: ["cat"], pipe_to_next: null },
        ],
      },
    });
  });

  it("does not reinterpret assignment-shaped arguments after the command", () => {
    expect(compileExecution("env A=one").plan).toMatchObject({
      kind: "pipeline",
      pipeline: { segments: [{ env: {}, command: ["env", "A=one"] }] },
    });
  });

  it("rejects an assignment without an executable", () => {
    expect(() => compileExecution("A=one")).toThrow(
      "environment assignments must be followed by a command",
    );
  });

  it("matches Cue precedence: job logic, then parallel, then serial", () => {
    expect(compileExecution("a -> b ||| c && d").plan).toEqual({
      kind: "on_success",
      left: {
        kind: "pipeline",
        pipeline: { segments: [{ env: {}, command: ["a"], pipe_to_next: null }] },
      },
      right: {
        kind: "parallel_all",
        branches: [
          {
            kind: "pipeline",
            pipeline: { segments: [{ env: {}, command: ["b"], pipe_to_next: null }] },
          },
          {
            kind: "on_success",
            left: {
              kind: "pipeline",
              pipeline: { segments: [{ env: {}, command: ["c"], pipe_to_next: null }] },
            },
            right: {
              kind: "pipeline",
              pipeline: { segments: [{ env: {}, command: ["d"], pipe_to_next: null }] },
            },
          },
        ],
      },
    });
  });

  it("compiles a .cue file to one fail-fast tree with source metadata", () => {
    const result = compileCueFile("# setup\nA=1 first\n\nsecond", "build.cue");
    expect(result.source).toEqual({ name: "build.cue" });
    expect(result.plan.kind).toBe("on_success");
  });

  it("rejects shell syntax and unclosed quotes", () => {
    expect(() => compileExecution("echo hi > out")).toThrow(
      'shell syntax ">" is not supported by Cue',
    );
    expect(() => compileExecution("echo 'hi")).toThrow("unterminated Cue word");
  });
});
