import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightVersions from "starlight-versions";

import { createLocaleRedirectScript } from "./src/lib/docs-locale.mjs";

const productionSite = process.env.SPARK_DOCS_SITE_URL?.trim() || "https://spark-docs.invalid";
const localeRedirectScript = createLocaleRedirectScript();

export default defineConfig({
  output: "static",
  site: productionSite,
  integrations: [
    starlight({
      title: {
        en: "Spark Docs",
        "zh-CN": "Spark 文档",
      },
      description:
        "Install, operate, and understand Spark across its CLI, local web workbench, daemon, and Hub surfaces.",
      favicon: "/spark.svg",
      editLink: {
        baseUrl: "https://github.com/zendev-lab/spark/edit/main/apps/spark-docs/",
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/zendev-lab/spark",
        },
      ],
      locales: {
        root: {
          label: "English",
          lang: "en",
        },
        zh: {
          label: "简体中文",
          lang: "zh-CN",
        },
      },
      defaultLocale: "root",
      plugins: [
        starlightVersions({
          current: { label: "Latest", redirect: "same-page" },
          versions: [{ slug: "0.2", label: "v0.2", redirect: "same-page" }],
        }),
      ],
      sidebar: [
        {
          label: "Start",
          translations: { zh: "开始" },
          items: [
            {
              label: "Overview",
              translations: { zh: "概览" },
              link: "/",
            },
            {
              label: "Getting started",
              translations: { zh: "快速开始" },
              link: "/getting-started/",
            },
            {
              label: "Plan and implement a change",
              translations: { zh: "规划并实现一个修改" },
              link: "/guides/plan-and-implement/",
            },
            {
              label: "Operator handbook",
              translations: { zh: "运维与完整使用手册" },
              link: "/guides/operator-handbook/",
            },
            {
              label: "Migrating to Spark 0.2",
              translations: { zh: "迁移到 Spark 0.2" },
              link: "/guides/migration-0.2/",
            },
          ],
        },
        {
          label: "Capabilities",
          translations: { zh: "能力地图" },
          items: [
            {
              label: "Feature map",
              translations: { zh: "功能地图" },
              link: "/concepts/feature-map/",
            },
          ],
        },
        {
          label: "Use Spark",
          translations: { zh: "使用 Spark" },
          items: [
            {
              label: "Local web",
              translations: { zh: "本地 Web" },
              link: "/guides/web/",
            },
            {
              label: "Runs and sessions",
              translations: { zh: "运行与会话" },
              link: "/guides/runs-and-sessions/",
            },
            {
              label: "Hub",
              translations: { zh: "Hub" },
              link: "/guides/hub/",
            },
            {
              label: "Collaboration and channels",
              translations: { zh: "协作与渠道" },
              link: "/guides/collaboration/",
            },
            {
              label: "Daemon Channels",
              translations: { zh: "Daemon 全局 Channel" },
              link: "/guides/channels/",
            },
            {
              label: "Side Threads",
              translations: { zh: "Side Threads" },
              link: "/guides/side-threads/",
            },
          ],
        },
        {
          label: "Automate",
          translations: { zh: "自动推进" },
          items: [
            {
              label: "Long-running work",
              translations: { zh: "长期工作" },
              link: "/guides/automation/",
            },
          ],
        },
        {
          label: "Operate and extend",
          translations: { zh: "运维与扩展" },
          items: [
            {
              label: "Surfaces and ownership",
              translations: { zh: "界面与所有权" },
              link: "/concepts/surfaces/",
            },
            {
              label: "Configuration and paths",
              translations: { zh: "配置与路径" },
              link: "/reference/configuration-and-paths/",
            },
            {
              label: "Troubleshooting",
              translations: { zh: "故障排查" },
              link: "/troubleshooting/",
            },
          ],
        },
        {
          label: "Reference",
          translations: { zh: "参考" },
          items: [
            {
              label: "CLI",
              translations: { zh: "CLI" },
              link: "/reference/cli/",
            },
            {
              label: "Agent tools",
              translations: { zh: "Agent 工具" },
              link: "/reference/tools/",
            },
          ],
        },
      ],
      head: [
        {
          tag: "script",
          attrs: { "data-spark-locale-redirect": "true" },
          content: localeRedirectScript,
        },
      ],
      customCss: ["./src/styles/custom.css"],
      components: {
        LanguageSelect: "./src/components/LanguageSelect.astro",
      },
      credits: false,
    }),
  ],
});
