#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(
  process.env.SPARK_USER_DOCS_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url))),
);
const docsRoot = join(root, "apps/spark-docs/src/content/docs");
const publicRoot = join(root, "apps/spark-docs/public");
const checkDist = process.argv.includes("--dist");
const failures = [];

const pages = (await listContentFiles(docsRoot)).toSorted();
const pageSet = new Set(pages);
const requiredPages = [
  "index.md",
  "getting-started.md",
  "concepts/feature-map.md",
  "concepts/surfaces.md",
  "guides/plan-and-execute.md",
  "guides/automation.md",
  "guides/tui.md",
  "guides/runs-and-sessions.md",
  "guides/collaboration.md",
  "guides/side-threads.md",
  "guides/hub.md",
  "guides/operator-handbook.md",
  "guides/migration-0.2.md",
  "reference/configuration-and-paths.md",
  "reference/cli.md",
  "reference/tools.md",
  "troubleshooting.md",
];
const archivedVersions = ["0.2"];

for (const page of requiredPages) {
  if (!pageSet.has(page)) failures.push(`missing English page: ${page}`);
  if (!pageSet.has(`zh/${page}`)) failures.push(`missing Chinese page: zh/${page}`);
}

for (const version of archivedVersions) {
  if (!pageSet.has(`${version}/index.md`)) {
    failures.push(`missing English archive root: ${version}/index.md`);
  }
  if (!pageSet.has(`zh/${version}/index.md`)) {
    failures.push(`missing Chinese archive root: zh/${version}/index.md`);
  }
}

for (const page of pages) {
  const counterpart = page.startsWith("zh/") ? page.slice(3) : `zh/${page}`;
  if (!pageSet.has(counterpart)) failures.push(`${page} has no locale counterpart`);

  const source = await readFile(join(docsRoot, page), "utf8");
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---/u)?.[1];
  if (!frontmatter) {
    failures.push(`${page} has no frontmatter`);
  } else {
    if (!/^title:\s+\S+/mu.test(frontmatter)) failures.push(`${page} has no title`);
    if (!/^description:\s+\S+/mu.test(frontmatter)) failures.push(`${page} has no description`);
  }
}

const routes = new Set(pages.map(routeForPage));
const publicFiles = new Set(await listPublicFiles(publicRoot));
for (const page of pages) {
  const source = await readFile(join(docsRoot, page), "utf8");
  for (const target of internalTargets(source)) {
    const pathname = normalizeTarget(target);
    if (publicFiles.has(pathname.slice(1))) continue;
    if (!routes.has(pathname)) failures.push(`${page} links to missing route ${pathname}`);
  }
}

const help = spawnSync(join(root, "apps/spark-cli/bin/spark"), ["--help"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, FORCE_COLOR: "0" },
});
// Source-behavior and product-content ratchets below intentionally target only
// Latest. Archived versions are frozen and checked for structure, locale pairs,
// internal links, and successful static output instead.
if (help.status !== 0) {
  const reason = help.stderr.trim() || `exit ${help.status}`;
  failures.push(`spark --help failed: ${reason}`);
} else {
  if (help.stdout.trim().length === 0) failures.push("spark --help returned no help text");
}

for (const page of ["reference/cli.md", "zh/reference/cli.md"]) {
  const source = await readFile(join(docsRoot, page), "utf8");
  for (const command of [
    "spark --help",
    "spark daemon --help",
    "spark hub --help",
    "/help",
    "/help commands",
    "/help all",
  ]) {
    if (!source.includes(command)) failures.push(`${page} does not teach discovery via ${command}`);
  }
}

for (const page of ["guides/plan-and-execute.md", "zh/guides/plan-and-execute.md"]) {
  const source = await readFile(join(docsRoot, page), "utf8");
  for (const command of ["/plan", "/execute"]) {
    if (!source.includes(command)) failures.push(`${page} does not teach ${command}`);
  }
}

for (const page of ["guides/automation.md", "zh/guides/automation.md"]) {
  const source = await readFile(join(docsRoot, page), "utf8");
  for (const command of [
    "/automate",
    "/goal",
    "/loop",
    "/repro",
    "/workflow run",
    "/workflow pause",
  ]) {
    if (!source.includes(command)) failures.push(`${page} does not teach ${command}`);
  }
}

for (const page of ["guides/tui.md", "zh/guides/tui.md"]) {
  const source = await readFile(join(docsRoot, page), "utf8");
  for (const command of ["/help", "/help commands", "/help all", "/inspect", "/automate"]) {
    if (!source.includes(command)) failures.push(`${page} does not teach ${command}`);
  }
}

const featureMapHeadings = {
  "concepts/feature-map.md": [
    "## 0. Product surfaces and distribution",
    "## 1. Core runtime: one daemon",
    "## 2. Interactive design: Hub Web and TUI",
    "## 3. Base agent tools",
    "## 4. Tasks and autonomous progress",
    "## 5. Channels and multi-session collaboration",
    "## 6. Models, context, extensions, and operations",
  ],
  "zh/concepts/feature-map.md": [
    "## 0. 产品表面与分发",
    "## 1. 核心运行时：一个 daemon",
    "## 2. 交互式设计：Hub Web 与 TUI",
    "## 3. 基础 agent 工具",
    "## 4. 任务与自主推进",
    "## 5. 渠道与多会话协作",
    "## 6. 模型、上下文、扩展与运维",
  ],
};
for (const [page, headings] of Object.entries(featureMapHeadings)) {
  const source = await readFile(join(docsRoot, page), "utf8");
  for (const heading of headings) {
    if (!source.includes(heading))
      failures.push(`${page} is missing feature-map heading ${heading}`);
  }
}

for (const page of ["reference/tools.md", "zh/reference/tools.md"]) {
  const source = await readFile(join(docsRoot, page), "utf8");
  for (const contract of [
    "active tool schema",
    "`issue | git_change | document`",
    "`skill_agent",
  ]) {
    if (!source.includes(contract)) failures.push(`${page} does not explain ${contract}`);
  }
  if (/Complete tool catalog|完整工具目录/u.test(source)) {
    failures.push(`${page} claims to own an exhaustive tool catalog`);
  }
  for (const internalName of [/\bimpl_/u]) {
    if (internalName.test(source)) failures.push(`${page} exposes internal tool ${internalName}`);
  }
}

for (const page of ["guides/collaboration.md", "zh/guides/collaboration.md"]) {
  const source = await readFile(join(docsRoot, page), "utf8");
  for (const term of [
    "Role",
    "Session",
    "Side Thread",
    "Feishu",
    "Infoflow",
    "QQ Bot",
    "`session`",
    "`ask`",
    "`context`",
    "`todo`",
  ]) {
    if (!source.includes(term)) failures.push(`${page} does not explain ${term}`);
  }
}

const journeyPages = [
  "getting-started.md",
  "zh/getting-started.md",
  "guides/plan-and-execute.md",
  "zh/guides/plan-and-execute.md",
];
const internalJourneyTerms = [
  /\binvocation\b/iu,
  /\bdriver\b/iu,
  /\blane\b/iu,
  /\bsettle\b/iu,
  /\blease\b/iu,
  /\bCAS\b/u,
  /\boutbox\b/iu,
  /\bturn admission\b/iu,
  /\breceipt\b/iu,
  /\bcursor\b/iu,
];
for (const page of journeyPages) {
  const source = await readFile(join(docsRoot, page), "utf8");
  for (const term of internalJourneyTerms) {
    if (term.test(source)) failures.push(`${page} exposes internal journey terminology: ${term}`);
  }
}

const gettingStartedLinks = {
  "getting-started.md": "/guides/plan-and-execute/",
  "zh/getting-started.md": "/zh/guides/plan-and-execute/",
};
for (const [page, target] of Object.entries(gettingStartedLinks)) {
  const source = await readFile(join(docsRoot, page), "utf8");
  if (!source.includes(target)) failures.push(`${page} does not link to ${target}`);
}

for (const page of ["reference/cli.md", "zh/reference/cli.md"]) {
  const source = await readFile(join(docsRoot, page), "utf8");
  if (source.includes("spark daemon sync")) {
    failures.push(`${page} documents the removed spark daemon sync command`);
  }
}

for (const { surface, args } of [
  {
    surface: "daemon",
    args: ["daemon", "--help"],
  },
  {
    surface: "hub",
    args: ["hub", "--help"],
  },
]) {
  const result = spawnSync(join(root, "apps/spark-cli/bin/spark"), args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  if (result.status !== 0) {
    failures.push(`${surface} help failed: ${result.stderr.trim() || `exit ${result.status}`}`);
    continue;
  }
  if (result.stdout.trim().length === 0) failures.push(`${surface} help returned no help text`);
}

const retiredCockpit = spawnSync(join(root, "apps/spark-cli/bin/spark"), ["cockpit", "--help"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, FORCE_COLOR: "0" },
});
if (
  retiredCockpit.status !== 2 ||
  !retiredCockpit.stderr.includes("Unknown spark subcommand: cockpit")
) {
  failures.push("retired spark cockpit dispatcher namespace is still accepted");
}

if (checkDist) {
  const distRoot = join(root, "apps/spark-docs/dist");

  for (const route of routes) {
    const output = route === "/" ? "index.html" : `${route.slice(1)}index.html`;
    if (!(await isFile(join(distRoot, output)))) {
      failures.push(`missing build output for route ${route}: ${output}`);
    }
  }

  for (const output of [
    "0.2/index.html",
    "0.2/getting-started/index.html",
    "zh/0.2/index.html",
    "zh/0.2/getting-started/index.html",
    "404.html",
    "pagefind/pagefind.js",
    "sitemap-index.xml",
  ]) {
    if (!(await isFile(join(distRoot, output)))) failures.push(`missing build output: ${output}`);
  }

  await checkBuiltHTML(distRoot, "index.html", [
    [/data-pagefind-filter="version:current"/u, "Latest Pagefind version filter"],
    [/>Latest<\/option>/u, "Latest version option"],
    [/>v0\.2<\/option>/u, "v0.2 version option"],
  ]);
  await checkBuiltHTML(distRoot, "0.2/getting-started/index.html", [
    [/rel="canonical" href="https?:\/\/[^"/]+\/0\.2\/getting-started\/"/u, "canonical URL"],
    [/hreflang="zh-CN" href="https?:\/\/[^"/]+\/zh\/0\.2\/getting-started\/"/u, "Chinese hreflang"],
    [/data-pagefind-filter="version:0\.2"/u, "v0.2 Pagefind version filter"],
    [/value="\/getting-started\/"/u, "same-page Latest version target"],
    [/value="\/0\.2\/getting-started\/"/u, "same-page v0.2 version target"],
    [/value="\/zh\/0\.2\/getting-started\/" data-spark-locale="zh"/u, "same-page Chinese target"],
    [/This content is for v0\.2\./u, "English outdated-version notice"],
    [/Search limited to v0\.2\./u, "English version-scoped search notice"],
  ]);
  await checkBuiltHTML(distRoot, "zh/0.2/getting-started/index.html", [
    [/<html lang="zh-CN"/u, "Chinese HTML language"],
    [
      /rel="canonical" href="https?:\/\/[^"/]+\/zh\/0\.2\/getting-started\/"/u,
      "Chinese canonical URL",
    ],
    [/hreflang="en" href="https?:\/\/[^"/]+\/0\.2\/getting-started\/"/u, "English hreflang"],
    [/data-pagefind-filter="version:0\.2"/u, "Chinese v0.2 Pagefind version filter"],
    [/value="\/0\.2\/getting-started\/" data-spark-locale="root"/u, "same-page English target"],
    [/此内容适用于 v0\.2。/u, "Chinese outdated-version notice"],
    [/搜索范围仅限 v0\.2。/u, "Chinese version-scoped search notice"],
  ]);

  const filterRoot = join(distRoot, "pagefind/filter");
  const filterEntries = await readdir(filterRoot, { withFileTypes: true });
  const filterContents = await Promise.all(
    filterEntries
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(join(filterRoot, entry.name))),
  );
  if (!filterContents.some((content) => content.includes("current") && content.includes("0.2"))) {
    failures.push("Pagefind version index does not contain both current and 0.2 filters");
  }
}

if (failures.length > 0) {
  console.error(
    ["Spark user docs check failed:", ...failures.map((item) => `- ${item}`)].join("\n"),
  );
  process.exit(1);
}

console.log(
  `Spark user docs check passed (${pages.length / 2} English/Chinese route pairs${
    checkDist ? "; static output verified" : ""
  }).`,
);

async function listContentFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listContentFiles(entryPath)));
      continue;
    }
    if (!entry.isFile() || ![".md", ".mdx"].includes(extname(entry.name))) continue;
    files.push(relative(docsRoot, entryPath).split(sep).join("/"));
  }
  return files;
}

async function listPublicFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listPublicFiles(entryPath)));
      continue;
    }
    if (entry.isFile()) files.push(relative(publicRoot, entryPath).split(sep).join("/"));
  }
  return files;
}

function routeForPage(page) {
  const withoutExtension = page.slice(0, -extname(page).length);
  const withoutIndex =
    withoutExtension === "index" ? "" : withoutExtension.replace(/\/index$/u, "");
  return `/${withoutIndex}${withoutIndex ? "/" : ""}`;
}

function internalTargets(source) {
  const targets = [];
  for (const match of source.matchAll(/\]\((\/[^)\s?#]*)(?:[?#][^)]*)?\)/gu)) {
    targets.push(match[1]);
  }
  for (const match of source.matchAll(
    /\b(?:href|link):?\s*=\s*["'](\/[^"'?#]*)(?:[?#][^"']*)?["']/gu,
  )) {
    targets.push(match[1]);
  }
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("link:")) continue;
    const rawTarget = trimmed.slice("link:".length).trim();
    if (!rawTarget.startsWith("/")) continue;
    const suffixIndex = rawTarget.search(/[\s?#]/u);
    targets.push(suffixIndex === -1 ? rawTarget : rawTarget.slice(0, suffixIndex));
  }
  return targets;
}

function normalizeTarget(target) {
  if (target === "/") return target;
  return target.endsWith("/") ? target : `${target}/`;
}

async function isFile(path) {
  try {
    const handle = await import("node:fs/promises");
    return (await handle.stat(path)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function checkBuiltHTML(distRoot, output, expectations) {
  if (!(await isFile(join(distRoot, output)))) return;
  const html = await readFile(join(distRoot, output), "utf8");
  for (const [pattern, label] of expectations) {
    if (!pattern.test(html)) failures.push(`${output} is missing ${label}`);
  }
}
