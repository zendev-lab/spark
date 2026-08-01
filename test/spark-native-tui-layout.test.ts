import assert from "node:assert/strict";
import { test } from "vitest";

import { composeSparkNativeFrame } from "../apps/spark-tui/src/native-tui/layout.ts";
import { visibleWidth } from "../apps/spark-tui/src/tui/pi-tui-adapter.ts";

const viewports = [
  [60, 18],
  [80, 24],
  [120, 30],
  [160, 40],
] as const;

function sections(
  overrides: Partial<Parameters<typeof composeSparkNativeFrame>[0]["sections"]> = {},
) {
  return {
    header: ["Spark · model=fixture · session=primary"],
    context: ["workspace=/very/long/workspace/path · branch=feature/layout"],
    transcript: ["old message", "recent message"],
    composer: ["────────────────", "> prompt"],
    footer: ["Enter send · Esc cancel"],
    runtimeFooter: ["runtime online"],
    ...overrides,
  };
}

test.each(viewports)("native frame fits %ix%i", (width, height) => {
  const lines = composeSparkNativeFrame({ width, height, sections: sections() });
  assert.ok(lines.length <= height);
  assert.ok(lines.every((line) => visibleWidth(line) <= width));
  assert.equal(lines.filter((line) => line.includes("Spark")).length, 1);
  assert.equal(lines.filter((line) => line.includes("model=fixture")).length, 1);
});

test("native frame truncates ANSI-styled long fields by visible width", () => {
  const lines = composeSparkNativeFrame({
    width: 24,
    height: 8,
    sections: sections({ header: ["\u001b[31mSpark · model=" + "x".repeat(80) + "\u001b[0m"] }),
  });
  assert.ok(lines.every((line) => visibleWidth(line) <= 24));
  assert.match(lines[0] ?? "", /Spark/);
});

test("constrained frames retain recent transcript, prompt, and footer", () => {
  const lines = composeSparkNativeFrame({
    width: 60,
    height: 7,
    sections: sections({ transcript: ["old-1", "old-2", "recent-1", "recent-2"] }),
  });
  assert.doesNotMatch(lines.join("\n"), /old-1/);
  assert.match(lines.join("\n"), /recent-2/);
  assert.match(lines.join("\n"), /> prompt/);
  assert.match(lines.join("\n"), /Enter send/);
  assert.match(lines.join("\n"), /runtime online/);
});

test("messages remain between context and composer", () => {
  const lines = composeSparkNativeFrame({ width: 80, height: 24, sections: sections() });
  const context = lines.findIndex((line) => line.includes("workspace="));
  const message = lines.findIndex((line) => line.includes("recent message"));
  const composer = lines.findIndex((line) => line.includes("> prompt"));
  assert.ok(context >= 0 && context < message && message < composer);
});

test.each([
  [60, 18],
  [80, 24],
] as const)("active long detail coexists with recent transcript at %ix%i", (width, height) => {
  const lines = composeSparkNativeFrame({
    width,
    height,
    sections: sections({
      detailActive: true,
      detail: Array.from({ length: 30 }, (_, index) => `detail-${index}`),
      transcript: ["old transcript", "latest transcript"],
    }),
  });
  assert.match(lines.join("\n"), /detail-/);
  assert.match(lines.join("\n"), /latest transcript/);
  assert.ok(lines.length <= height);
  assert.ok(lines.every((line) => visibleWidth(line) <= width));
});

test("long detail, auxiliary, and queue preserve the latest transcript", () => {
  const lines = composeSparkNativeFrame({
    width: 60,
    height: 18,
    sections: sections({
      detailActive: true,
      detail: Array.from({ length: 30 }, (_, index) => `detail-${index}`),
      auxiliary: Array.from({ length: 30 }, (_, index) => `auxiliary-${index}`),
      queue: Array.from({ length: 30 }, (_, index) => `queue-${index}`),
      transcript: ["old transcript", "latest transcript"],
    }),
  });
  const rendered = lines.join("\n");
  assert.match(rendered, /detail-/);
  assert.match(rendered, /auxiliary-/);
  assert.match(rendered, /queue-/);
  assert.match(rendered, /latest transcript/);
});

test("bottom overflow retains a composer line before footer and runtime", () => {
  const lines = composeSparkNativeFrame({
    width: 40,
    height: 3,
    sections: sections({
      header: [],
      context: [],
      transcript: [],
      composer: ["composer-1", "composer-2", "composer-prompt"],
      footer: ["footer-1", "footer-2"],
      runtimeFooter: ["runtime-1", "runtime-2"],
    }),
  });
  assert.match(lines.join("\n"), /composer-prompt/);
  assert.ok(lines.length <= 3);
});

test.each(viewports)("long frame fields appear at most once at %ix%i", (width, height) => {
  const fields = ["workspace-field", "session-field", "model-field", "footer-field"];
  const lines = composeSparkNativeFrame({
    width,
    height,
    sections: sections({
      header: [`Spark · model-field=${"m".repeat(120)} · session-field=${"s".repeat(120)}`],
      context: [`workspace-field=${"w".repeat(160)}`],
      footer: [`footer-field=${"f".repeat(120)}`],
    }),
  });
  for (const field of fields) {
    assert.ok(lines.filter((line) => line.includes(field)).length <= 1, field);
  }
  assert.ok(lines.length <= height);
  assert.ok(lines.every((line) => visibleWidth(line) <= width));
});

test("inactive and empty detail sections consume no rows while active detail is visible", () => {
  const inactive = composeSparkNativeFrame({
    width: 80,
    height: 12,
    sections: sections({ detail: ["detail panel"], detailActive: false, queue: [] }),
  });
  assert.doesNotMatch(inactive.join("\n"), /detail panel/);

  const active = composeSparkNativeFrame({
    width: 80,
    height: 12,
    sections: sections({ detail: ["detail panel"], detailActive: true, queue: [] }),
  });
  assert.match(active.join("\n"), /detail panel/);
  assert.equal(
    active.some((line) => line.length === 0),
    false,
  );
});
