import {
  startQrConnect,
  type QrConnectCallbacks,
  type QrConnectOptions,
} from "@tencent-connect/qqbot-connector";

export interface QqbotQrCredentials {
  appId: string;
  clientSecret: string;
  /** OpenID of the QQ user who approved the bot binding. */
  userOpenid?: string;
}

export interface QqbotQrAuthCallbacks {
  onQrCode(url: string): void;
  onQrExpired?(): void;
  onSuccess(credentials: QqbotQrCredentials[]): void;
  onFailure(error: Error): void;
}

export type QqbotQrConnector = (
  callbacks: QrConnectCallbacks,
  options?: QrConnectOptions,
) => () => void;

/**
 * Start the official QQ Bot binding ceremony without exposing returned
 * credentials outside the daemon-owned caller.
 */
export function startQqbotQrAuth(
  callbacks: QqbotQrAuthCallbacks,
  options: {
    connector?: QqbotQrConnector;
    source?: string;
  } = {},
): () => void {
  const connector = options.connector ?? startQrConnect;
  return connector(
    {
      onQrDisplayed: (url) => callbacks.onQrCode(url),
      ...(callbacks.onQrExpired ? { onQrExpired: () => callbacks.onQrExpired?.() } : {}),
      onSuccess: (credentials) =>
        callbacks.onSuccess(
          credentials.map((credential) => ({
            appId: credential.appId,
            clientSecret: credential.appSecret,
            ...(credential.userOpenid ? { userOpenid: credential.userOpenid } : {}),
          })),
        ),
      onFailure: (error) => callbacks.onFailure(error),
    },
    {
      displayQrCodeToConsole: false,
      source: options.source ?? "spark",
    },
  );
}
