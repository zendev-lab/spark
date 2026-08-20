import { randomBytes, timingSafeEqual } from "node:crypto";

export const SPARK_WEB_TOKEN_COOKIE = "spark_web_token";
export const SPARK_WEB_TOKEN_QUERY = "token";
export const SPARK_WEB_TOKEN_ENV = "SPARK_WEB_TOKEN";
export const SPARK_WEB_TOKEN_HEADER = "x-spark-web-token";

export function generateSparkWebToken(): string {
  return randomBytes(24).toString("base64url");
}

export function resolveSparkWebToken(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[SPARK_WEB_TOKEN_ENV]?.trim();
  return configured && configured.length > 0 ? configured : generateSparkWebToken();
}

export function tokensMatch(expected: string, provided: string | null | undefined): boolean {
  if (!provided) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function tokenFromRequest(input: {
  cookie?: string | null;
  query?: string | null;
  header?: string | null;
}): string | null {
  const query = input.query?.trim();
  if (query) return query;
  const header = input.header?.trim();
  if (header) return header;
  const cookie = input.cookie?.trim();
  return cookie || null;
}
