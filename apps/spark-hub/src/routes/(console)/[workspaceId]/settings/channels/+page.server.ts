import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

/** Channel configuration is daemon-global; retain the old route only for bookmarks. */
export const load: PageServerLoad = () => {
  throw redirect(303, "/settings/channels");
};
