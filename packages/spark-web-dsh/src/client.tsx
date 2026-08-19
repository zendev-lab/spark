/**
 * spark-web-dsh client plugin: provider onboarding for the DSH web profile.
 *
 * Mounted by `spark web` alongside the spark-llm host plugin. It registers an
 * earlier `settings.onboarding` step (`spark-provider-select`, order -50)
 * than the shipped DeepSeek-key dialog (order 0). The step:
 *
 * - completes immediately when a credential is already configured (DSH's own
 *   `deepseek-official` step then also auto-completes, so no dialog appears);
 * - otherwise shows a provider picker plus an API-key field; saving stores
 *   the key through the host credentials service (the derived reference, e.g.
 *   `BAIDU_ONEAPI_API_KEY` for `baidu-oneapi`) and completes the step.
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

/** The provider route spark-llm registers, and its conventional key ref. */
const BAIDU_ONEAPI_PROVIDER = "baidu-oneapi";
const DEFAULT_API_KEY_ENV = "BAIDU_ONEAPI_API_KEY";

/** Mirror of the DSH Models page convention: route id -> credential ref. */
function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

interface ProviderRow {
  provider: string;
  displayName: string;
  settingsNs: string;
  settingsPath: string[];
  declared: boolean;
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

function ProviderSelectOnboarding({ complete, api }: OnboardingProps) {
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
        const [pv, cv] = await Promise.all([
          api.llm.providers({}),
          api.credentials.describe({ refs: [DEFAULT_API_KEY_ENV] }),
        ]);
        if (stale) return;
        if (cv.result.ok && cv.result.value.credentials[DEFAULT_API_KEY_ENV] !== undefined) {
          complete();
          return;
        }
        const rows = pv.result.ok ? pv.result.value.providers : [];
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
      const ref = selected === BAIDU_ONEAPI_PROVIDER ? DEFAULT_API_KEY_ENV : deriveKeyRef(selected);
      const response = await api.credentials.set({ ref, value: key.trim() });
      if (!response.result.ok) {
        setSaveError(response.result.error?.message ?? "保存失败");
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
        <h2 style={{ margin: "0 0 4px", fontSize: "18px" }}>选择 Provider 并配置</h2>
        <p style={{ margin: "0 0 12px", fontSize: "13px", color: "#666" }}>
          {error ?? "选择一个模型提供商并填入 API Key 开始使用。"}
        </p>
        {!error && providers.length === 0 ? (
          <p style={{ fontSize: "13px", color: "#b45309" }}>当前没有可配置的 provider。</p>
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
              placeholder="API Key"
              value={key}
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
            跳过
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
              disabled={saving || !selected || key.trim().length === 0}
              onClick={save}
            >
              {saving ? "保存中…" : "保存并开始"}
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
        inject: () => Record<string, unknown>;
      },
      component: unknown,
    ): unknown;
  };
  connection: { api: OnboardingApi };
}

export const name = "spark-web-dsh";
export const inject = ["slots", "locale", "connection", "remote"];

export function apply(ctx: ClientContext): void {
  ctx.slots.inject("settings.onboarding", () =>
    ctx.slots.register(
      {
        name: "settings.onboarding",
        id: "spark-provider-select",
        order: -50,
        inject: () => ({ api: ctx.connection.api }),
      },
      ProviderSelectOnboarding,
    ),
  );
}

export default { name, inject, apply };
