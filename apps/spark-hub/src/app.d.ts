declare global {
  namespace App {
    interface Error {
      message: string;
      code?: string;
      requestId?: string;
    }

    interface Locals {
      requestId: string;
      sessionToken: string | null;
      /**
       * Remote member sessions: the workspaces leased to their granted daemons.
       * `null` means unrestricted (owner session or local access).
       */
      authorizedWorkspaceIds: string[] | null;
      /** Remote member sessions: daemon grants are the authentication boundary. */
      authorizedDaemonIds: string[] | null;
      hasControlPlaneAccess: boolean;
    }
  }
}

export {};
