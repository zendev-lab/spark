import { readFileSync } from "node:fs";
import { parse } from "svelte/compiler";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import ChannelSessionIcon from "./ChannelSessionIcon.svelte";

type CssAtRule = {
  type: "Atrule";
  name: string;
  prelude: string;
  block: { children: Array<{ type: string; block?: { children: unknown[] } }> };
};

const cases = [
  { adapter: "qqbot", scope: "c2c", scopeClass: "scope-private" },
  { adapter: "feishu", scope: "chat", scopeClass: "scope-conversation" },
  { adapter: "infoflow", scope: "group", scopeClass: "scope-group" },
  { adapter: "qqbot", scope: "channel", scopeClass: "scope-channel" },
] as const;

describe("ChannelSessionIcon component contract", () => {
  it.each(cases)("renders $adapter/$scope as one accessible composite icon", (entry) => {
    const label = `${entry.adapter} ${entry.scope}`;
    const { body } = render(ChannelSessionIcon, { props: { ...entry, label } });

    expect(body).toContain('role="img"');
    expect(body).toContain(`aria-label="${label}"`);
    expect(body).toContain(`title="${label}"`);
    expect(body).toContain(entry.adapter);
    expect(body).toContain(entry.scopeClass);
    expect(body.match(/<svg/g)).toHaveLength(2);
    expect(body).toContain('aria-hidden="true"');
  });

  it("retains a structured forced-colors override for the scope indicator", () => {
    const ast = parse(
      readFileSync(new URL("./ChannelSessionIcon.svelte", import.meta.url), "utf8"),
    );
    const forcedColors = ast.css?.children.find(
      (node: { type: string; name?: string; prelude?: string }) =>
        node.type === "Atrule" &&
        node.name === "media" &&
        node.prelude === "(forced-colors: active)",
    ) as CssAtRule | undefined;

    expect(forcedColors?.type).toBe("Atrule");
    expect(forcedColors?.block.children).toHaveLength(1);
    expect(forcedColors?.block.children[0]?.type).toBe("Rule");
    expect(forcedColors?.block.children[0]?.block?.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: "forced-color-adjust", value: "none" }),
      ]),
    );
  });
});
