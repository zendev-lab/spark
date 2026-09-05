import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import ChannelSessionIcon from "./ChannelSessionIcon.svelte";

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
    if (entry.adapter === "qqbot") {
      expect(body).toContain('fill="currentColor"');
    } else {
      expect(body).not.toContain('fill="currentColor"');
    }
  });
});
