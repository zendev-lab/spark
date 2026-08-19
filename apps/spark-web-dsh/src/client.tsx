/**
 * spark-web-dsh client plugin: provider onboarding for the DSH web profile.
 *
 * Mounted by `spark web-dsh` alongside the spark-llm host plugin. It registers an
 * earlier `settings.onboarding` step (`spark-provider-select`, order -50)
 * than the shipped DeepSeek-key dialog (order 0). The step:
 *
 * - completes immediately when a credential is already configured (DSH's own
 *   `deepseek-official` step then also auto-completes, so no dialog appears);
 * - otherwise shows the configured provider routes (Baidu OneAPI, Kimi Coding,
 *   and OpenAI Codex); API-key routes can be configured here while OAuth routes
 *   remain managed by Spark's OAuth flow;
 *
 * The bundle is built with `pnpm --filter @zendev-lab/spark-web-dsh run build`
 * into `lib/client.js` as a `window.__ModuleLoader__.load({...})` module;
 * `react` and `@deepseek-ai/*` stay external and resolve from the DSH web
 * runtime at load time.
 */
import { useEffect, useState } from "react";

/**
 * Chromium omits `crypto.randomUUID()` on plain-HTTP non-localhost origins.
 * DSH calls it while selecting a workspace, so install an RFC 4122 UUID-v4
 * fallback using `getRandomValues()`, which remains available there.
 */
export function installRandomUuidPolyfill(cryptoApi: Crypto | undefined = globalThis.crypto): void {
  if (cryptoApi === undefined || typeof cryptoApi.randomUUID === "function") return;

  Object.defineProperty(cryptoApi, "randomUUID", {
    configurable: true,
    value: () => {
      const bytes = new Uint8Array(16);
      cryptoApi.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
      return [
        hex.slice(0, 4).join(""),
        hex.slice(4, 6).join(""),
        hex.slice(6, 8).join(""),
        hex.slice(8, 10).join(""),
        hex.slice(10, 16).join(""),
      ].join("-");
    },
  });
}

installRandomUuidPolyfill();

const ONBOARDING_LOCALE_NS = "spark.provider-onboarding";

export const providerOnboardingMessages = {
  zh: {
    title: "选择 Provider 并配置",
    description:
      "选择一个已配置的模型提供商。API Key provider 可直接在这里配置，OAuth provider 请使用登录流程。",
    empty: "当前没有可配置的 provider。",
    oauthRequired: "该 provider 使用 OAuth，请通过 Spark 的 OAuth 登录流程配置。",
    saveFailed: "保存失败",
    oauthPlaceholder: "OAuth provider，请使用 Spark 登录",
    apiKeyPlaceholder: "API Key",
    skip: "跳过",
    saving: "保存中…",
    oauthLoginRequired: "需要 OAuth 登录",
    saveAndStart: "保存并开始",
  },
  en: {
    title: "Choose and configure a provider",
    description:
      "Choose a configured model provider. API-key providers can be configured here; use the sign-in flow for OAuth providers.",
    empty: "No configurable providers are available.",
    oauthRequired: "This provider uses OAuth. Configure it through Spark's OAuth sign-in flow.",
    saveFailed: "Failed to save",
    oauthPlaceholder: "OAuth provider — sign in through Spark",
    apiKeyPlaceholder: "API Key",
    skip: "Skip",
    saving: "Saving…",
    oauthLoginRequired: "OAuth sign-in required",
    saveAndStart: "Save and start",
  },
} as const;

type OnboardingMessageKey = keyof (typeof providerOnboardingMessages)["en"];
type Translate = (key: OnboardingMessageKey) => string;

/** Provider routes already wired into the Spark DSH plugin. */
const BAIDU_ONEAPI_PROVIDER = "baidu-oneapi";
const KIMI_CODING_PROVIDER = "kimi-coding";
const OPENAI_CODEX_PROVIDER = "openai-codex";
const DEFAULT_API_KEY_ENV = "BAIDU_ONEAPI_API_KEY";
const KIMI_API_KEY_ENV = "KIMI_API_KEY";

/** Mirror of the DSH Models page convention: route id -> credential ref. */
function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/** API-key reference for a provider; OAuth-only routes return undefined. */
export function providerApiKeyRef(provider: string): string | undefined {
  if (provider === OPENAI_CODEX_PROVIDER) return undefined;
  if (provider === BAIDU_ONEAPI_PROVIDER) return DEFAULT_API_KEY_ENV;
  if (provider === KIMI_CODING_PROVIDER) return KIMI_API_KEY_ENV;
  return deriveKeyRef(provider);
}

interface ProviderRow {
  provider: string;
  displayName: string;
  settingsNs: string;
  settingsPath: string[];
  declared: boolean;
}

export function isOAuthProvider(provider: string): boolean {
  return provider === OPENAI_CODEX_PROVIDER;
}

interface WireResult<T> {
  result: { ok: boolean; value: T; error?: { message: string } };
}

interface OnboardingApi {
  llm: {
    providers(input: unknown): Promise<WireResult<{ providers: ProviderRow[] }>>;
  };
  credentials: {
    describe(input: {
      refs: string[];
    }): Promise<WireResult<{ credentials: Record<string, unknown> }>>;
    set(input: { ref: string; value: string }): Promise<WireResult<unknown>>;
  };
}

interface OnboardingProps {
  complete: () => void;
  api: OnboardingApi;
  t: Translate;
}

export function isCredentialsAccessDenied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("/api/credentials.") && /HTTP\s+403\b/i.test(message);
}

const modalStyle: Record<string, string> = {
  position: "fixed",
  inset: "0",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.45)",
  zIndex: "1000",
};

const cardStyle: Record<string, string> = {
  width: "min(440px, 90vw)",
  background: "#fff",
  borderRadius: "12px",
  padding: "24px",
  boxShadow: "0 8px 40px rgba(0,0,0,0.25)",
  fontFamily: "system-ui, sans-serif",
  color: "#1a1a1a",
};

const fieldStyle: Record<string, string> = {
  width: "100%",
  boxSizing: "border-box",
  marginTop: "8px",
  padding: "8px 10px",
  borderRadius: "8px",
  border: "1px solid #ccc",
  fontSize: "14px",
};

const rowStyle: Record<string, string> = {
  display: "flex",
  gap: "8px",
  justifyContent: "flex-end",
  marginTop: "16px",
};

function ProviderSelectOnboarding({ complete, api, t }: OnboardingProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [selected, setSelected] = useState("");
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    void (async () => {
      try {
        const pv = await api.llm.providers({});
        const rows = pv.result.ok ? pv.result.value.providers : [];
        const refs = rows.flatMap((row) => {
          const ref = providerApiKeyRef(row.provider);
          return ref === undefined ? [] : [ref];
        });
        let cv: WireResult<{ credentials: Record<string, unknown> }> | undefined;
        try {
          cv = refs.length > 0 ? await api.credentials.describe({ refs }) : undefined;
        } catch (caught) {
          // DSH keeps credential reads loopback-only. A remote browser uses
          // credentials already resolved by the Spark host instead of opening
          // or failing the local secret configuration UI.
          if (isCredentialsAccessDenied(caught)) {
            if (stale) return;
            complete();
            return;
          }
          throw caught;
        }
        if (stale) return;
        if (
          cv?.result.ok &&
          Object.values(cv.result.value.credentials).some((credential) => credential !== undefined)
        ) {
          complete();
          return;
        }
        if (stale) return;
        const preferred = rows.some((row) => row.provider === BAIDU_ONEAPI_PROVIDER)
          ? BAIDU_ONEAPI_PROVIDER
          : (rows[0]?.provider ?? "");
        setProviders(rows);
        setSelected(preferred);
        setLoading(false);
      } catch (caught) {
        if (stale) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        setLoading(false);
      }
    })();
    return () => {
      stale = true;
    };
  }, [api, complete]);

  const save = async () => {
    if (!selected || key.trim().length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const ref = providerApiKeyRef(selected);
      if (ref === undefined) {
        setSaveError(t("oauthRequired"));
        setSaving(false);
        return;
      }
      const response = await api.credentials.set({ ref, value: key.trim() });
      if (!response.result.ok) {
        setSaveError(response.result.error?.message ?? t("saveFailed"));
      } else {
        complete();
      }
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;

  return (
    <div style={modalStyle}>
      <div style={cardStyle}>
        <h2 style={{ margin: "0 0 4px", fontSize: "18px" }}>{t("title")}</h2>
        <p style={{ margin: "0 0 12px", fontSize: "13px", color: "#666" }}>
          {error ?? t("description")}
        </p>
        {!error && providers.length === 0 ? (
          <p style={{ fontSize: "13px", color: "#b45309" }}>{t("empty")}</p>
        ) : null}
        {!error && providers.length > 0 ? (
          <>
            <select
              style={fieldStyle}
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              {providers.map((row) => (
                <option key={row.provider} value={row.provider}>
                  {row.displayName}
                </option>
              ))}
            </select>
            <input
              style={fieldStyle}
              type="password"
              placeholder={
                isOAuthProvider(selected) ? t("oauthPlaceholder") : t("apiKeyPlaceholder")
              }
              value={key}
              disabled={isOAuthProvider(selected)}
              onChange={(event) => setKey(event.target.value)}
            />
            {saveError !== null ? (
              <p style={{ margin: "8px 0 0", fontSize: "13px", color: "#b91c1c" }}>{saveError}</p>
            ) : null}
          </>
        ) : null}
        <div style={rowStyle}>
          <button
            style={{
              padding: "8px 14px",
              borderRadius: "8px",
              border: "1px solid #ccc",
              background: "#fff",
              cursor: "pointer",
            }}
            onClick={complete}
          >
            {t("skip")}
          </button>
          {!error && providers.length > 0 ? (
            <button
              style={{
                padding: "8px 14px",
                borderRadius: "8px",
                border: "none",
                background: "#2563eb",
                color: "#fff",
                cursor: "pointer",
              }}
              disabled={saving || isOAuthProvider(selected) || !selected || key.trim().length === 0}
              onClick={save}
            >
              {saving
                ? t("saving")
                : isOAuthProvider(selected)
                  ? t("oauthLoginRequired")
                  : t("saveAndStart")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface ClientContext {
  slots: {
    inject(slot: string, register: () => unknown): void;
    register(
      options: {
        name: string;
        id: string;
        order: number;
        locale: string;
        inject: () => Record<string, unknown>;
      },
      component: unknown,
    ): unknown;
  };
  locale: {
    register(namespace: string, dictionaries: typeof providerOnboardingMessages): () => void;
  };
  connection: { api: OnboardingApi };
}

export const name = "spark-web-dsh";
export const inject = ["slots", "locale", "connection", "remote"];

export function apply(ctx: ClientContext): void {
  ctx.locale.register(ONBOARDING_LOCALE_NS, providerOnboardingMessages);
  ctx.slots.inject("settings.onboarding", () =>
    ctx.slots.register(
      {
        name: "settings.onboarding",
        id: "spark-provider-select",
        order: -50,
        locale: ONBOARDING_LOCALE_NS,
        inject: () => ({ api: ctx.connection.api }),
      },
      ProviderSelectOnboarding,
    ),
  );
}

export default { name, inject, apply };
