export const SPARK_WEB_LAUNCH_CWD_ENV = "SPARK_WEB_LAUNCH_CWD";

export function sparkWebLaunchDirectory(): string {
  return process.env[SPARK_WEB_LAUNCH_CWD_ENV] ?? process.cwd();
}
