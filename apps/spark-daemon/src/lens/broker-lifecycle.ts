import type { DatabaseSync } from "node:sqlite";

import { DaemonLensDocumentMirrors } from "./document-mirror.ts";
import { DaemonLensProcessBroker } from "./provider-process-broker.ts";
import { DaemonLensStateStore } from "./state-store.ts";

export interface DaemonLensBrokerOwner {
  broker: DaemonLensProcessBroker;
  mirrors: DaemonLensDocumentMirrors;
}

const owners = new WeakMap<DatabaseSync, Promise<DaemonLensBrokerOwner>>();

export async function prepareDaemonLensBroker(db: DatabaseSync): Promise<DaemonLensBrokerOwner> {
  const existing = owners.get(db);
  if (existing) return await existing;
  const opening = (async () => {
    const broker = new DaemonLensProcessBroker({
      stateStore: new DaemonLensStateStore(db),
    });
    try {
      await broker.recoverOrphans();
      return {
        broker,
        mirrors: new DaemonLensDocumentMirrors(),
      };
    } catch (error) {
      await broker.close();
      throw error;
    }
  })();
  owners.set(db, opening);
  try {
    return await opening;
  } catch (error) {
    owners.delete(db);
    throw error;
  }
}

export async function closeDaemonLensBroker(db: DatabaseSync): Promise<void> {
  const owner = owners.get(db);
  owners.delete(db);
  if (!owner) return;
  const resolved = await owner.catch(() => undefined);
  await resolved?.broker.close();
}
