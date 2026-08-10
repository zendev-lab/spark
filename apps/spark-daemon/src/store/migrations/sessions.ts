import { migrateSessionRequestCompletionDeliverySchema } from "./current-schema.js";
import type { Migration } from "./types.js";

export const sessionMigrations = [
  {
    id: "sessions.request-completion-claim-lease",
    owner: "sessions",
    up: migrateSessionRequestCompletionDeliverySchema,
  },
] satisfies Migration[];
