window.__ModuleLoader__.load({
  id: "@zendev-lab/spark-web-dsh",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    ("use strict");
    var __defProp = Object.defineProperty;
    var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames = Object.getOwnPropertyNames;
    var __hasOwnProp = Object.prototype.hasOwnProperty;
    var __export = (target, all) => {
      for (var name2 in all) __defProp(target, name2, { get: all[name2], enumerable: true });
    };
    var __copyProps = (to, from, except, desc) => {
      if ((from && typeof from === "object") || typeof from === "function") {
        for (let key of __getOwnPropNames(from))
          if (!__hasOwnProp.call(to, key) && key !== except)
            __defProp(to, key, {
              get: () => from[key],
              enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
            });
      }
      return to;
    };
    var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

    // src/client.tsx
    var client_exports = {};
    __export(client_exports, {
      apply: () => apply,
      default: () => client_default,
      inject: () => inject,
      installRandomUuidPolyfill: () => installRandomUuidPolyfill,
      isCredentialsAccessDenied: () => isCredentialsAccessDenied,
      name: () => name,
    });
    module.exports = __toCommonJS(client_exports);
    var import_react = require("react");
    var import_jsx_runtime = require("react/jsx-runtime");
    function installRandomUuidPolyfill(cryptoApi = globalThis.crypto) {
      if (cryptoApi === void 0 || typeof cryptoApi.randomUUID === "function") return;
      Object.defineProperty(cryptoApi, "randomUUID", {
        configurable: true,
        value: () => {
          const bytes = new Uint8Array(16);
          cryptoApi.getRandomValues(bytes);
          bytes[6] = (bytes[6] & 15) | 64;
          bytes[8] = (bytes[8] & 63) | 128;
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
    var BAIDU_ONEAPI_PROVIDER = "baidu-oneapi";
    var DEFAULT_API_KEY_ENV = "BAIDU_ONEAPI_API_KEY";
    function deriveKeyRef(provider) {
      return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
    }
    function isCredentialsAccessDenied(error) {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("/api/credentials.") && /HTTP\s+403\b/i.test(message);
    }
    var modalStyle = {
      position: "fixed",
      inset: "0",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "rgba(0,0,0,0.45)",
      zIndex: "1000",
    };
    var cardStyle = {
      width: "min(440px, 90vw)",
      background: "#fff",
      borderRadius: "12px",
      padding: "24px",
      boxShadow: "0 8px 40px rgba(0,0,0,0.25)",
      fontFamily: "system-ui, sans-serif",
      color: "#1a1a1a",
    };
    var fieldStyle = {
      width: "100%",
      boxSizing: "border-box",
      marginTop: "8px",
      padding: "8px 10px",
      borderRadius: "8px",
      border: "1px solid #ccc",
      fontSize: "14px",
    };
    var rowStyle = {
      display: "flex",
      gap: "8px",
      justifyContent: "flex-end",
      marginTop: "16px",
    };
    function ProviderSelectOnboarding({ complete, api }) {
      const [loading, setLoading] = (0, import_react.useState)(true);
      const [error, setError] = (0, import_react.useState)(null);
      const [providers, setProviders] = (0, import_react.useState)([]);
      const [selected, setSelected] = (0, import_react.useState)("");
      const [key, setKey] = (0, import_react.useState)("");
      const [saving, setSaving] = (0, import_react.useState)(false);
      const [saveError, setSaveError] = (0, import_react.useState)(null);
      (0, import_react.useEffect)(() => {
        let stale = false;
        void (async () => {
          try {
            const pv = await api.llm.providers({});
            let cv;
            try {
              cv = await api.credentials.describe({ refs: [DEFAULT_API_KEY_ENV] });
            } catch (caught) {
              if (isCredentialsAccessDenied(caught)) {
                complete();
                return;
              }
              throw caught;
            }
            if (stale) return;
            if (cv.result.ok && cv.result.value.credentials[DEFAULT_API_KEY_ENV] !== void 0) {
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
          const ref =
            selected === BAIDU_ONEAPI_PROVIDER ? DEFAULT_API_KEY_ENV : deriveKeyRef(selected);
          const response = await api.credentials.set({ ref, value: key.trim() });
          if (!response.result.ok) {
            setSaveError(response.result.error?.message ?? "\u4FDD\u5B58\u5931\u8D25");
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
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
        style: modalStyle,
        children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
          style: cardStyle,
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
              style: { margin: "0 0 4px", fontSize: "18px" },
              children: "\u9009\u62E9 Provider \u5E76\u914D\u7F6E",
            }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
              style: { margin: "0 0 12px", fontSize: "13px", color: "#666" },
              children:
                error ??
                "\u9009\u62E9\u4E00\u4E2A\u6A21\u578B\u63D0\u4F9B\u5546\u5E76\u586B\u5165 API Key \u5F00\u59CB\u4F7F\u7528\u3002",
            }),
            !error && providers.length === 0
              ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
                  style: { fontSize: "13px", color: "#b45309" },
                  children: "\u5F53\u524D\u6CA1\u6709\u53EF\u914D\u7F6E\u7684 provider\u3002",
                })
              : null,
            !error && providers.length > 0
              ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, {
                  children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("select", {
                      style: fieldStyle,
                      value: selected,
                      onChange: (event) => setSelected(event.target.value),
                      children: providers.map((row) =>
                        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                          "option",
                          { value: row.provider, children: row.displayName },
                          row.provider,
                        ),
                      ),
                    }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
                      style: fieldStyle,
                      type: "password",
                      placeholder: "API Key",
                      value: key,
                      onChange: (event) => setKey(event.target.value),
                    }),
                    saveError !== null
                      ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
                          style: { margin: "8px 0 0", fontSize: "13px", color: "#b91c1c" },
                          children: saveError,
                        })
                      : null,
                  ],
                })
              : null,
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
              style: rowStyle,
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
                  style: {
                    padding: "8px 14px",
                    borderRadius: "8px",
                    border: "1px solid #ccc",
                    background: "#fff",
                    cursor: "pointer",
                  },
                  onClick: complete,
                  children: "\u8DF3\u8FC7",
                }),
                !error && providers.length > 0
                  ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
                      style: {
                        padding: "8px 14px",
                        borderRadius: "8px",
                        border: "none",
                        background: "#2563eb",
                        color: "#fff",
                        cursor: "pointer",
                      },
                      disabled: saving || !selected || key.trim().length === 0,
                      onClick: save,
                      children: saving
                        ? "\u4FDD\u5B58\u4E2D\u2026"
                        : "\u4FDD\u5B58\u5E76\u5F00\u59CB",
                    })
                  : null,
              ],
            }),
          ],
        }),
      });
    }
    var name = "spark-web-dsh";
    var inject = ["slots", "locale", "connection", "remote"];
    function apply(ctx) {
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
    var client_default = { name, inject, apply };
    module.exports = { default: { name, inject, apply }, name, inject, apply };
    return module.exports;
  },
});
