import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  createLocaleRedirectScript,
  docsLocaleStorageKey,
  localizedDocsPathname,
  persistDocsLocalePreference,
  rootLocaleRedirectTarget,
} from "./docs-locale.mjs";

for (const language of ["zh-CN", "zh-Hans", "zh-TW"]) {
  void test(`maps ${language} to the Chinese docs`, () => {
    assert.equal(rootLocaleRedirectTarget({ pathname: "/", languages: [language] }), "/zh/");
  });
}

void test("keeps English for an English browser language", () => {
  assert.equal(rootLocaleRedirectTarget({ pathname: "/", languages: ["en-US"] }), null);
});

void test("uses browser language order and falls back to navigator.language", () => {
  assert.equal(rootLocaleRedirectTarget({ pathname: "/", languages: ["en-US", "zh-CN"] }), null);
  assert.equal(
    rootLocaleRedirectTarget({ pathname: "/", languages: ["fr-FR", "zh-CN", "en-US"] }),
    "/zh/",
  );
  assert.equal(rootLocaleRedirectTarget({ pathname: "/", language: "zh-Hans" }), "/zh/");
});

void test("manual locale preference overrides browser language", () => {
  assert.equal(
    rootLocaleRedirectTarget({
      pathname: "/",
      storedLocale: "root",
      languages: ["zh-CN"],
    }),
    null,
  );
  assert.equal(
    rootLocaleRedirectTarget({
      pathname: "/",
      storedLocale: "zh",
      languages: ["en-US"],
    }),
    "/zh/",
  );
});

void test("never redirects a deep link or versioned route", () => {
  for (const pathname of ["/getting-started/", "/0.2/", "/zh/0.2/"]) {
    assert.equal(rootLocaleRedirectTarget({ pathname, languages: ["zh-CN"] }), null);
  }
});

void test("maps locale paths without losing version or page", () => {
  assert.equal(localizedDocsPathname("/0.2/page/", "zh"), "/zh/0.2/page/");
  assert.equal(localizedDocsPathname("/zh/0.2/page/", "root"), "/0.2/page/");
  assert.equal(localizedDocsPathname("/page/", "zh"), "/zh/page/");
  assert.equal(localizedDocsPathname("/zh/page/", "root"), "/page/");
});

void test("supports a configured base path and HTML output", () => {
  assert.equal(
    localizedDocsPathname("/docs/0.2/page/", "zh", { baseUrl: "/docs/" }),
    "/docs/zh/0.2/page/",
  );
  assert.equal(
    localizedDocsPathname("/docs/zh/0.2/page.html", "root", {
      baseUrl: "/docs/",
      trailingSlash: "never",
    }),
    "/docs/0.2/page.html",
  );
});

void test("manual persistence is explicit and storage failures are safe", () => {
  const writes = [];
  assert.equal(
    persistDocsLocalePreference({ setItem: (...args) => writes.push(args) }, "zh"),
    true,
  );
  assert.deepEqual(writes, [[docsLocaleStorageKey, "zh"]]);
  assert.equal(
    persistDocsLocalePreference(
      {
        setItem() {
          throw new Error("blocked");
        },
      },
      "root",
    ),
    false,
  );
});

void test("generated redirect script infers Chinese without persisting it", () => {
  const result = runRedirectScript({ pathname: "/", languages: ["zh-CN"] });
  assert.equal(result.replacedWith, "/zh/");
  assert.equal(result.writeCount, 0);
});

void test("generated redirect script safely keeps English when storage is unavailable", () => {
  const result = runRedirectScript({
    pathname: "/",
    languages: ["zh-CN"],
    throwOnRead: true,
  });
  assert.equal(result.replacedWith, null);
});

void test("generated redirect script ignores non-root paths", () => {
  const result = runRedirectScript({ pathname: "/0.2/", languages: ["zh-CN"] });
  assert.equal(result.replacedWith, null);
});

function runRedirectScript({
  pathname,
  storedLocale = null,
  languages = [],
  language = "",
  throwOnRead = false,
}) {
  let replacedWith = null;
  let writeCount = 0;
  const location = {
    pathname,
    replace(target) {
      replacedWith = target;
    },
  };
  const localStorage = {
    getItem(key) {
      assert.equal(key, docsLocaleStorageKey);
      if (throwOnRead) throw new Error("blocked");
      return storedLocale;
    },
    setItem() {
      writeCount += 1;
    },
  };

  vm.runInNewContext(createLocaleRedirectScript(), {
    navigator: { language, languages },
    window: { localStorage, location },
  });

  return { replacedWith, writeCount };
}
