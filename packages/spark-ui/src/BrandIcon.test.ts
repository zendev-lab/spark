import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import BrandIcon from "./BrandIcon.svelte";

describe("BrandIcon component contract", () => {
  it("renders decorative brand artwork with current color", () => {
    const { body } = render(BrandIcon, { props: { name: "qq", size: 18 } });

    expect(body).toContain('width="18"');
    expect(body).toContain('fill="currentColor"');
    expect(body).toContain('aria-hidden="true"');
    expect(body).not.toContain('role="img"');
    expect(body).toContain(`<path d="`);
  });
});
