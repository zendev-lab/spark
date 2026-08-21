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

  it("matches Cue word quoting and double-quote escapes", () => {
    const command = (
      compileExecution(String.raw`printf "" "line\nnext" "tab\tstop" "keep\$pair" a'b'c`).plan as {
        pipeline: { segments: Array<{ command: string[] }> };
      }
    ).pipeline.segments[0]!.command;
    expect(command).toEqual([
      "printf",
      "",
      "line\nnext",
      "tab\tstop",
      String.raw`keep\$pair`,
      "abc",
    ]);
  });

  it("preserves backslashes outside double quotes", () => {
    expect(compileExecution(String.raw`printf C:\tmp`).plan).toMatchObject({
      pipeline: { segments: [{ command: ["printf", String.raw`C:\tmp`] }] },
    });
  });

  it.each(["a-> b", "a ->b", "a~> b", "a |||b", "a|?| b"])(
    "requires whitespace around Cue chain operators in %s",
    (input) => {
      expect(() => compileExecution(input)).toThrow("must be surrounded by whitespace");
    },
  );

  it("keeps Cue pipe operators valid without surrounding whitespace", () => {
    expect(compileExecution("printf ok|>cat").plan).toMatchObject({
      pipeline: {
        segments: [
          { command: ["printf", "ok"], pipe_to_next: "Stdout" },
          { command: ["cat"], pipe_to_next: null },
        ],
      },
    });
  });

  it("rejects Cue directives instead of compiling them as executables", () => {
    expect(() => compileCueFile(":cd /tmp\nprintf ok", "build.cue")).toThrow(
      'Cue directive ":cd" is not supported by the direct execution compiler',
    );
  });

  it.each(["printf a ->\n:cd /tmp", "printf a\n||| :env set A=B"])(
    "rejects a Cue directive after an operator continuation in %s",
    (input) => {
      expect(() => compileCueFile(input, "build.cue")).toThrow(
        "is not supported by the direct execution compiler",
      );
    },
  );

  it("keeps a quoted colon executable as an ordinary word", () => {
    expect(compileExecution('\":echo\" ok').plan).toMatchObject({
      pipeline: { segments: [{ command: [":echo", "ok"] }] },
    });
  });

  it("matches Cue file comments, shebangs, and operator continuations", () => {
    const result = compileCueFile(
      '#!/usr/bin/env cue\nprintf "#" # note\nprintf a ->\n  printf b\nprintf c\n||| printf d',
      "build.cue",
    );
    expect(result.plan).toMatchObject({
      kind: "on_success",
      left: {
        kind: "on_success",
        left: { pipeline: { segments: [{ command: ["printf", "#"] }] } },
        right: {
          kind: "on_success",
          left: { pipeline: { segments: [{ command: ["printf", "a"] }] } },
          right: { pipeline: { segments: [{ command: ["printf", "b"] }] } },
        },
      },
      right: {
        kind: "parallel_all",
        branches: [
          { pipeline: { segments: [{ command: ["printf", "c"] }] } },
          { pipeline: { segments: [{ command: ["printf", "d"] }] } },
        ],
      },
    });
  });
});
