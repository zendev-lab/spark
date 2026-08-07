import assert from "node:assert/strict";
import { test } from "vitest";

import { SparkKeybindings } from "../host/keybindings.ts";
import { createSparkNativeTuiComponentHarness } from "../test-support/spark-native-tui-component-harness.ts";
import { visibleWidth } from "../tui/pi-tui-adapter.ts";

const CTRL_C = "\x03";
const CTRL_D = "\x04";
const CTRL_O = "\x0f";
const CTRL_Y = "\x19";

test("component harness exposes renderer-neutral TUI state transitions", async () => {
  const harness = createSparkNativeTuiComponentHarness();

  assert.deepEqual(
    {
      focused: harness.snapshot().focused,
      toolsExpanded: harness.snapshot().toolsExpanded,
      thinkingExpanded: harness.snapshot().thinkingExpanded,
      activeHubPanel: harness.snapshot().hub.activePanel,
    },
    {
      focused: false,
      toolsExpanded: false,
      thinkingExpanded: false,
      activeHubPanel: undefined,
    },
  );

  await harness.press("\x0f");
  await harness.press("\x14");
  harness.app.toggleHubPanel("overview");

  assert.deepEqual(
    {
      toolsExpanded: harness.snapshot().toolsExpanded,
      thinkingExpanded: harness.snapshot().thinkingExpanded,
      activeHubPanel: harness.snapshot().hub.activePanel,
    },
    {
      toolsExpanded: true,
      thinkingExpanded: true,
      activeHubPanel: "overview",
    },
  );
});

test("component harness drives the real editor input and submit path", async () => {
  const submitted: string[] = [];
  const harness = createSparkNativeTuiComponentHarness({
    responder(input) {
      submitted.push(input);
      return "acknowledged";
    },
  });

  await harness.type("component editor input");
  assert.match(harness.render(), /component editor input/u);

  await harness.press("\r");
  assert.deepEqual(submitted, ["component editor input"]);
  assert.match(harness.render(), /> component editor input/u);
  assert.match(harness.render(), /acknowledged/u);
});

test("component harness renders deterministically at the active viewport", async () => {
  const harness = createSparkNativeTuiComponentHarness({ cols: 80, rows: 24 });
  harness.session.addSystemMessage("viewport contract");

  await harness.resize(42, 10);
  const snapshot = harness.snapshot();

  assert.equal(snapshot.columns, 42);
  assert.equal(snapshot.rows, 10);
  assert.ok(snapshot.renderedLines.length <= 10);
  assert.ok(snapshot.renderedLines.every((line) => visibleWidth(line) <= 42));
  assert.match(snapshot.renderedLines.join("\n"), /viewport contract/u);
});

test("component harness renders queued user messages with the ordinary user prefix", () => {
  const harness = createSparkNativeTuiComponentHarness();
  harness.session.messages.push({
    role: "user",
    text: "queued transcript input",
    queued: true,
    details: { queueMode: "followUp" },
  });

  const rendered = harness.render();
  assert.match(rendered, /> queued transcript input/u);
  assert.doesNotMatch(rendered, /queued(?: follow-up| steer)?>/iu);
});

test("component harness resolves configured shortcuts before recording either exit chord", async () => {
  const keybindings = new SparkKeybindings();
  const harness = createSparkNativeTuiComponentHarness({ keybindings });
  keybindings.setOverride("app.toggleTools", "ctrl+y");

  await harness.press(CTRL_Y);
  assert.equal(harness.snapshot().toolsExpanded, true);

  await harness.press(CTRL_O);
  assert.equal(harness.snapshot().toolsExpanded, true, "override disables the former default key");

  await harness.press(CTRL_C);
  assert.equal(harness.snapshot().exited, true);

  const ctrlDHarness = createSparkNativeTuiComponentHarness();
  await ctrlDHarness.press(CTRL_D);
  assert.equal(ctrlDHarness.snapshot().exited, true);
});
