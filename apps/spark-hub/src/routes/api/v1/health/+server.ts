import { json } from "@sveltejs/kit";

export function GET(): Response {
  return json({ service: "spark-hub", status: "ok" }, { headers: { "cache-control": "no-store" } });
}
