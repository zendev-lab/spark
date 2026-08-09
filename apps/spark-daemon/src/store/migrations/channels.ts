import { migrateChannelDeliverySchema } from "./current-schema.js";
import type { Migration } from "./types.js";

export const channelMigrations = [
  {
    id: "channels.delivery-ledger-v2",
    owner: "channels",
    up: migrateChannelDeliverySchema,
  },
] satisfies Migration[];
