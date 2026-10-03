import { runSparkWebProcess } from "./cli.ts";
import { startSparkWebDevelopmentServer } from "./vite-server.ts";

runSparkWebProcess({ startDevelopmentServer: startSparkWebDevelopmentServer });
