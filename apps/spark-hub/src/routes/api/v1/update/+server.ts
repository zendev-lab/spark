import { json } from "@sveltejs/kit";
import { readHubUpdateProjection } from "$lib/server/update-projection";

export async function GET(): Promise<Response> {
  return json(await readHubUpdateProjection(), {
    headers: { "cache-control": "no-store" },
  });
}
