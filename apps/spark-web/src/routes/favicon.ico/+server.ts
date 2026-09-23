import { redirect } from "@sveltejs/kit";

export function GET(): Response {
  redirect(307, "/icons/spark.svg");
}
