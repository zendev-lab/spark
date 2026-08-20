import {
  settingsNamespace as hr,
  installSettingsSection as yr,
  deepEqualJson as Ar,
} from "@deepseek-ai/dsh-settings";
import { assertUsableApiKey as Sr } from "@deepseek-ai/dsh-llm";
import O from "@deepseek-ai/schemastery";
import { anthropicMessagesApi as kr, openAIResponsesApi as vr } from "@earendil-works/pi-ai/compat";
import { homedir as xr } from "node:os";
import { join as H } from "node:path";
import { readFileSync as br } from "node:fs";
import * as Z from "@earendil-works/pi-ai";
function T(t, e, r, n = {}) {
  let o = Be(t),
    i = J(e, "baseMs"),
    s = J(r, "maxMs"),
    d = Math.max(0, o - 1),
    a = n.exponentCap === void 0 ? d : Math.min(d, ie(n.exponentCap, "options.exponentCap"));
  return Math.min(s, i * 2 ** a);
}
function oe(t, e = Math.random) {
  let r = ie(t, "ceilingMs"),
    n = e();
  if (!Number.isFinite(n)) throw new RangeError("random() must return a finite number");
  let o = Math.max(0, Math.min(1, n));
  return Math.floor(r * (0.5 + o * 0.5));
}
function ie(t, e) {
  return Math.floor(J(t, e));
}
function J(t, e) {
  if (!Number.isFinite(t) || t < 0)
    throw new RangeError(`${e} must be a finite non-negative number`);
  return t;
}
function Be(t) {
  if (!Number.isFinite(t)) throw new RangeError("attempt must be a finite number");
  return Math.max(0, Math.floor(t));
}
var $e = 1e3,
  Ke = 6e4,
  q = "PROVIDER_STREAM_TERMINAL_LESS";
function C(t, e, r) {
  let n = !1,
    o,
    i = t,
    s = je(r.maxRetries);
  return {
    async *[Symbol.asyncIterator]() {
      if (n) {
        if (o) return;
        throw new Error(`Provider "${r.providerName}" stream is already being consumed`);
      }
      n = !0;
      let a = 0,
        l = !1,
        p = !1,
        u,
        f = [];
      for (;;) {
        let m = !1;
        try {
          for await (let c of i) {
            if (c.type === "start") {
              p || ((p = !0), yield c);
              continue;
            }
            if (c.type === "error") {
              if (!l && a < s && r.signal?.aborted !== !0 && r.shouldRetry(c.error)) {
                m = !0;
                break;
              }
              ((o = c.error), yield c);
              return;
            }
            if (c.type === "done") {
              ((o = c.message), yield c);
              return;
            }
            ("partial" in c && c.partial && (u = c.partial),
              c.type === "toolcall_end" && "toolCall" in c && f.push(c.toolCall),
              (l = !0),
              yield c);
          }
        } catch (c) {
          if (!(!l && a < s && r.signal?.aborted !== !0 && r.shouldRetryThrown?.(c) === !0))
            throw c;
          m = !0;
        }
        if (!m) {
          let c = u && f.length > 0 ? { ...u, content: f, stopReason: "toolUse" } : void 0;
          if (c && Ge(c)) {
            ((o = c), delete o.errorMessage, yield { type: "done", reason: "toolUse", message: o });
            return;
          }
          throw Object.assign(
            new Error(`Provider "${r.providerName}" stream ended without a terminal event`),
            { code: q },
          );
        }
        ((a += 1), await ae(se(a, r), r.signal), (i = e()));
      }
    },
    async result() {
      if (o) return o;
      if (n)
        throw new Error(
          `Provider "${r.providerName}" stream ended without a final assistant message`,
        );
      n = !0;
      let a = 0;
      for (;;) {
        try {
          let l = await i.result();
          if (!(!We(l) && a < s && r.signal?.aborted !== !0 && r.shouldRetry(l)))
            return ((o = l), l);
        } catch (l) {
          if (!(a < s && r.signal?.aborted !== !0 && r.shouldRetryThrown?.(l) === !0)) throw l;
        }
        ((a += 1), await ae(se(a, r), r.signal), (i = e()));
      }
    },
  };
}
function de(t) {
  return t.stopReason === "error" && typeof t.errorMessage == "string" && X(t.errorMessage);
}
function X(t) {
  return (
    /unexpected non-whitespace character after json at position \d+(?: \(line \d+ column \d+\))?/iu.test(
      t,
    ) ||
    /unexpected end of json input/iu.test(t) ||
    /unterminated string in json(?: at position \d+)?/iu.test(t) ||
    /expected .+ in json at position \d+(?: \(line \d+ column \d+\))?/iu.test(t)
  );
}
function We(t) {
  return Array.isArray(t.content) && t.content.length > 0;
}
function Ge(t) {
  return (
    Array.isArray(t.content) &&
    t.content.some((e) => !!e && typeof e == "object" && e.type === "toolCall")
  );
}
function je(t) {
  return Number.isFinite(t) && t > 0 ? Math.floor(t) : 0;
}
function se(t, e) {
  let r = e.maxRetryDelayMs,
    n = typeof r == "number" && Number.isFinite(r) && r > 0 ? Math.floor(r) : Ke;
  return oe(T(t, Math.min($e, n), n));
}
function ae(t, e) {
  return new Promise((r, n) => {
    if (e?.aborted) {
      n(e.reason instanceof Error ? e.reason : new Error("Provider stream retry aborted"));
      return;
    }
    let o = () => {
        (clearTimeout(i),
          n(e?.reason instanceof Error ? e.reason : new Error("Provider stream retry aborted")));
      },
      i = setTimeout(() => {
        (e?.removeEventListener("abort", o), r());
      }, t);
    e?.addEventListener("abort", o, { once: !0 });
  });
}
var ze = "MODEL_EMPTY_RESPONSE",
  P = {
    auth: { retriable: !1, cooldown: !0, failover: !0 },
    rate_limit: { retriable: !0, cooldown: !0, failover: !0 },
    context_overflow: { retriable: !1, cooldown: !1, failover: !1 },
    provider_mismatch: { retriable: !1, cooldown: !1, failover: !1 },
    transient: { retriable: !0, cooldown: !0, failover: !0 },
    fatal: { retriable: !1, cooldown: !1, failover: !1 },
    aborted: { retriable: !1, cooldown: !1, failover: !1 },
  };
function A(t) {
  let e = He(t),
    r = Ye(e);
  return {
    failureClass: r,
    policy: P[r],
    message: e.message,
    ...(e.code !== void 0 ? { code: e.code } : {}),
    ...(e.status !== void 0 ? { status: e.status } : {}),
  };
}
function Ye(t) {
  let e = t.message.toLowerCase();
  return t.stopReason === "aborted"
    ? "aborted"
    : t.code === ze ||
        t.code === q ||
        /terminal event|terminal outcome|terminal-less|terminal less|without a final assistant message/u.test(
          e,
        )
      ? "transient"
      : /mismatched api:/u.test(e)
        ? "provider_mismatch"
        : /context[_ -]?(window|length|overflow)|maximum (?:context|prompt length)|prompt is too long|too many tokens|context window is full|请精简对话历史|缩小工具\/?文件输出/u.test(
              e,
            )
          ? "context_overflow"
          : t.status === 401 ||
              t.status === 403 ||
              /no api key|invalid api key|unauthori[sz]ed|forbidden|authentication|permission denied/u.test(
                e,
              )
            ? "auth"
            : t.status === 429 ||
                /rate[_\s-]?limit|too many requests|quota exceeded|insufficient quota|concurrency limit|please retry later/u.test(
                  e,
                )
              ? "rate_limit"
              : (t.status && (t.status === 408 || t.status === 409 || t.status >= 500)) ||
                  /econnreset|etimedout|timeout|socket hang up|stream[_ -]?read[_ -]?error|temporary|temporarily|network error|overloaded|try again later|servers are currently overloaded/u.test(
                    e,
                  ) ||
                  X(e)
                ? "transient"
                : "fatal";
}
function He(t) {
  let e = Ve(t);
  return {
    message: e.messages.find((n) => n.trim())?.trim() || "unknown provider failure",
    ...(e.code !== void 0 ? { code: e.code } : {}),
    ...(e.status !== void 0 ? { status: e.status } : {}),
    ...(e.stopReason !== void 0 ? { stopReason: e.stopReason } : {}),
  };
}
function Ve(t) {
  let e = [],
    r,
    n,
    o;
  function i(s) {
    if (s == null) return;
    if (typeof s == "string") {
      e.push(s);
      return;
    }
    if (s instanceof Error) {
      (e.push(s.message), (r ??= le(s)), (n ??= Q(s)), s.cause && i(s.cause));
      return;
    }
    if (!N(s)) {
      e.push(Je(s));
      return;
    }
    ((r ??= le(s)), (n ??= Q(s)));
    let d = s.stopReason;
    typeof d == "string" && (o ??= d);
    let a = s.errorMessage;
    typeof a == "string" && e.push(a);
    let l = s.message;
    (typeof l == "string" ? e.push(l) : l !== void 0 && i(l),
      s.assistantMessage !== void 0 && i(s.assistantMessage),
      s.error !== void 0 && i(s.error),
      s.cause !== void 0 && i(s.cause),
      s.response !== void 0 && i(s.response));
  }
  return (
    i(t),
    {
      messages: e,
      ...(r !== void 0 ? { code: r } : {}),
      ...(n !== void 0 ? { status: n } : {}),
      ...(o !== void 0 ? { stopReason: o } : {}),
    }
  );
}
function le(t) {
  if (N(t))
    for (let e of ["code", "errorCode"]) {
      let r = t[e];
      if (typeof r == "string" && r.trim() && !/^\d{3}$/u.test(r)) return r.trim();
    }
}
function Je(t) {
  return typeof t == "number" || typeof t == "boolean" || typeof t == "bigint"
    ? t.toString()
    : typeof t == "symbol"
      ? (t.description ?? "symbol provider failure")
      : typeof t == "function"
        ? t.name || "function provider failure"
        : typeof t == "object"
          ? (JSON.stringify(t) ?? "object provider failure")
          : "unknown provider failure";
}
function Q(t) {
  if (!N(t)) return;
  for (let r of ["status", "statusCode", "code"]) {
    let n = t[r];
    if (typeof n == "number" && Number.isInteger(n)) return n;
    if (typeof n == "string" && /^\d{3}$/u.test(n)) return Number(n);
  }
  let e = t.response;
  if (N(e)) return Q(e);
}
function N(t) {
  return !!t && typeof t == "object" && !Array.isArray(t);
}
var F = "baidu-oneapi",
  ee = "baidu-oneapi",
  me = "https://oneapi-comate.baidu-int.com",
  w = `${me}/v1`,
  qe = 3,
  Xe = "You are a helpful assistant.",
  Qe = "high",
  Ze = {
    "claude-opus-5": "Opus 5",
    "deepseek-v4-flash": "deepseek-v4-flash-0731-internal",
    "gpt-5.6-luna": "gpt-5.6-luna",
    "gpt-5.6-sol": "gpt-5.6-sol",
    "gpt-5.6-terra": "gpt-5.6-terra",
    "grok-4.5": "grok-4.5",
    "grok-4.6": "grok-4.6",
  },
  et = new Set(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "grok-4.5", "grok-4.6"]);
function S(t) {
  return Ze[t] ?? t;
}
function ge(t) {
  let e = (o, i, s) => At(t, o, i, s),
    r = (o, i, s) => St(t, o, i, s),
    n = (o, i, s) => (et.has(o.id) ? r(o, i, s) : e(o, i, s));
  return { register: (o) => Mt(o, n), stream: n, streamAnthropic: e, streamOpenAIResponses: r };
}
var tt = { input: 0.1, output: 0.6, cacheRead: 0.01, cacheWrite: 0.125 },
  rt = { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0.3125 },
  nt = { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.625 },
  I = { minimal: "low", xhigh: "xhigh" },
  ot = { input: 5.5, output: 27.5, cacheRead: 0.55, cacheWrite: 6.875 },
  it = { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 },
  st = { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 2 },
  at = { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2 },
  U = 0,
  D;
function he(t) {
  return {
    stream: (e, r, n) => ue(() => t.stream(e, r, n)),
    streamSimple: (e, r, n) => ue(() => t.streamSimple(e, r, n)),
  };
}
function ue(t) {
  let e = dt(),
    r;
  try {
    r = t();
  } catch (n) {
    throw (e(), n);
  }
  try {
    r.result().then(e, e);
  } catch (n) {
    throw (e(), n);
  }
  return r;
}
function dt() {
  (U === 0 && ((D = process.env.OPENAI_LOG), (process.env.OPENAI_LOG = "off")), (U += 1));
  let t = !1;
  return () => {
    t ||
      ((t = !0),
      (U -= 1),
      !(U > 0) &&
        (process.env.OPENAI_LOG === "off" &&
          (D === void 0
            ? Reflect.deleteProperty(process.env, "OPENAI_LOG")
            : (process.env.OPENAI_LOG = D)),
        (D = void 0)));
  };
}
function lt(t, e) {
  let r = e ? t.thinkingLevelMap?.[e] : void 0;
  if (typeof r == "string") return r;
  if (r !== null)
    switch (e) {
      case "minimal":
      case "low":
        return "low";
      case "medium":
        return "medium";
      case "high":
        return "high";
      case "xhigh":
        return "xhigh";
      default:
        return;
    }
}
function b(t) {
  return typeof t == "object" && t !== null && !Array.isArray(t);
}
function ye(t, e) {
  return { ...t, api: e };
}
var pe = "context_length_exceeded",
  ut = [
    /\bcontext (?:window|length) (?:is )?(?:full|exceeded)\b/iu,
    /\bmaximum context (?:window|length)(?: size)?(?: is| has been)? exceeded\b/iu,
    /\bmaximum prompt length (?:is|of) \d+\b/iu,
    /\bprompt (?:is )?too long for (?:the )?context window\b/iu,
    /\bcontext[_ -]length[_ -]exceeded\b/iu,
  ];
function pt(t) {
  return t.stopReason !== "error" || typeof t.errorMessage != "string"
    ? !1
    : ut.some((e) => e.test(t.errorMessage));
}
function ct(t) {
  if (!Array.isArray(t)) return t;
  let e = !1,
    r = t.map((n) => {
      if (n.type !== "thinking" || n.redacted === !0) return n;
      let o = n.thinking;
      return typeof o != "string" || o.trim().length === 0
        ? n
        : ((e = !0), { ...n, thinking: "", redacted: !0 });
    });
  return e ? r : t;
}
function L(t) {
  let e = pt(t) && !t.errorMessage?.includes(pe) ? `${pe}: ${t.errorMessage}` : t.errorMessage;
  return {
    ...t,
    ...(e !== void 0 ? { errorMessage: e } : {}),
    ...(Array.isArray(t.content) ? { content: ct(t.content) } : {}),
    api: ee,
    provider: F,
  };
}
function ft(t) {
  return L(t);
}
function mt(t) {
  return t.type === "done"
    ? { ...t, message: L(t.message) }
    : t.type === "error"
      ? { ...t, error: L(t.error) }
      : { ...t, partial: L(t.partial) };
}
function gt(t) {
  return mt(t);
}
function ce(t) {
  return {
    async *[Symbol.asyncIterator]() {
      for await (let e of t) yield gt(e);
    },
    async result() {
      return ft(await t.result());
    },
  };
}
function Ae(t, e) {
  try {
    return ce(e());
  } catch (r) {
    return ce(ht(t, r));
  }
}
function ht(t, e) {
  let r = {
      role: "assistant",
      content: [],
      api: ee,
      provider: F,
      model: t.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: e instanceof Error ? e.message : String(e),
      timestamp: Date.now(),
    },
    n = Z.createAssistantMessageEventStream();
  return (n.push({ type: "error", reason: "error", error: r }), n);
}
function Se(t) {
  if (t === void 0 || t === "BAIDU_ONEAPI_API_KEY") return process.env.BAIDU_ONEAPI_API_KEY;
  if (t === "OPENAI_API_KEY")
    throw new Error("baidu-oneapi does not accept OPENAI_API_KEY; use BAIDU_ONEAPI_API_KEY.");
  return t;
}
function yt(t, e, r) {
  if (!b(t)) return t;
  let n = { ...t, model: e },
    o = n.thinking;
  return (
    b(o) &&
      o.type === "enabled" &&
      ((n.thinking = {
        type: "adaptive",
        display: typeof o.display == "string" ? o.display : "summarized",
      }),
      r && (n.output_config = { ...(b(n.output_config) ? n.output_config : {}), effort: r })),
    n
  );
}
function At(t, e, r, n) {
  let o = S(e.id),
    i = Se(n?.apiKey),
    s = ye(e, "anthropic-messages"),
    a = n?.reasoning ?? (e.reasoning ? Qe : void 0),
    l = lt(e, a);
  return Ae(e, () =>
    t.anthropicMessages.stream(s, r, {
      ...n,
      ...(i !== void 0 ? { apiKey: i } : {}),
      thinkingEnabled: a !== void 0 && a !== "off",
      ...(l !== void 0 ? { effort: l } : {}),
      async onPayload(p) {
        let u = yt(p, o, l);
        return (await n?.onPayload?.(u, e)) ?? u;
      },
    }),
  );
}
function St(t, e, r, n) {
  let o = S(e.id),
    i = Se(n?.apiKey),
    s = ye(e, "openai-responses"),
    { systemPrompt: d, ...a } = r,
    l = d || Xe,
    p = () =>
      Ae(e, () =>
        t.openAIResponses.streamSimple(s, a, {
          ...n,
          ...(i !== void 0 ? { apiKey: i } : {}),
          fetch: vt(n?.fetch),
          async onPayload(u) {
            let f = kt(u, o),
              m = b(f) ? { ...f, instructions: l } : f;
            return (await n?.onPayload?.(m, e)) ?? m;
          },
        }),
      );
  return C(p(), p, {
    providerName: F,
    maxRetries: n?.maxRetries ?? qe,
    ...(n?.maxRetryDelayMs !== void 0 ? { maxRetryDelayMs: n.maxRetryDelayMs } : {}),
    ...(n?.signal !== void 0 ? { signal: n.signal } : {}),
    shouldRetry: (u) => de(u) || A(u).failureClass === "transient",
    shouldRetryThrown: (u) => A(u).failureClass === "transient",
  });
}
function kt(t, e) {
  return b(t) ? { ...t, model: e } : t;
}
function vt(t) {
  return async (e, r) => {
    let n = await (t ?? globalThis.fetch)(e, r);
    if (!n.body || !xt(n)) return n;
    let o = new Headers(n.headers);
    return (
      o.delete("content-length"),
      o.delete("content-encoding"),
      new Response(n.body.pipeThrough(bt()), {
        status: n.status,
        statusText: n.statusText,
        headers: o,
      })
    );
  };
}
function xt(t) {
  return t.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === !0;
}
function bt() {
  let t = new TextDecoder(),
    e = new TextEncoder(),
    r = "";
  return new TransformStream({
    transform(n, o) {
      r += t.decode(n, { stream: !0 });
      let i = r.indexOf(`
`);
      for (; i >= 0;) {
        let s = r.slice(0, i);
        ((r = r.slice(i + 1)),
          o.enqueue(
            e.encode(`${fe(s)}
`),
          ),
          (i = r.indexOf(`
`)));
      }
    },
    flush(n) {
      ((r += t.decode()), r && n.enqueue(e.encode(fe(r))));
    },
  });
}
function fe(t) {
  let e = t.endsWith("\r") ? "\r" : "",
    r = e ? t.slice(0, -1) : t;
  if (!r.startsWith("data:") || !r.endsWith(":")) return t;
  let n = r.indexOf(":"),
    o = r.slice(0, n + 1),
    s = r.slice(n + 1).slice(0, -1);
  try {
    let d = JSON.parse(s.trim());
    if (!b(d) || typeof d.type != "string" || !d.type.startsWith("response.")) return t;
  } catch {
    return t;
  }
  return o + s + e;
}
function Mt(t, e) {
  t.registerProvider(F, {
    name: "Baidu OneAPI",
    baseUrl: process.env.BAIDU_ONEAPI_BASE_URL ?? me,
    apiKey: "BAIDU_ONEAPI_API_KEY",
    api: ee,
    streamSimple: e,
    models: [
      {
        id: "claude-opus-5",
        name: "Claude Opus 5",
        transportApi: "anthropic-messages",
        transportModelId: S("claude-opus-5"),
        reasoning: !0,
        thinkingLevelMap: {
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
        },
        input: ["text", "image"],
        cost: ot,
        contextWindow: 384e3,
        maxTokens: 32e3,
      },
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        transportApi: "anthropic-messages",
        transportModelId: S("deepseek-v4-flash"),
        reasoning: !0,
        thinkingLevelMap: {
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "high",
        },
        input: ["text"],
        cost: it,
        contextWindow: 768e3,
        maxTokens: 32768,
      },
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        baseUrl: process.env.BAIDU_ONEAPI_OPENAI_BASE_URL ?? w,
        transportApi: "openai-responses",
        transportModelId: S("gpt-5.6-sol"),
        reasoning: !0,
        thinkingLevelMap: I,
        input: ["text", "image"],
        cost: nt,
        contextWindow: 384e3,
        maxTokens: 32768,
      },
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        baseUrl: process.env.BAIDU_ONEAPI_OPENAI_BASE_URL ?? w,
        transportApi: "openai-responses",
        transportModelId: S("gpt-5.6-luna"),
        reasoning: !0,
        thinkingLevelMap: I,
        input: ["text", "image"],
        cost: tt,
        contextWindow: 384e3,
        maxTokens: 32768,
      },
      {
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        baseUrl: process.env.BAIDU_ONEAPI_OPENAI_BASE_URL ?? w,
        transportApi: "openai-responses",
        transportModelId: S("gpt-5.6-terra"),
        reasoning: !0,
        thinkingLevelMap: I,
        input: ["text", "image"],
        cost: rt,
        contextWindow: 384e3,
        maxTokens: 32768,
      },
      {
        id: "grok-4.5",
        name: "Grok 4.5",
        baseUrl: process.env.BAIDU_ONEAPI_OPENAI_BASE_URL ?? w,
        transportApi: "openai-responses",
        transportModelId: S("grok-4.5"),
        reasoning: !0,
        thinkingLevelMap: I,
        input: ["text", "image"],
        cost: st,
        contextWindow: 5e5,
        maxTokens: 32768,
      },
      {
        id: "grok-4.6",
        name: "Grok 4.6",
        baseUrl: process.env.BAIDU_ONEAPI_OPENAI_BASE_URL ?? w,
        transportApi: "openai-responses",
        transportModelId: S("grok-4.6"),
        reasoning: !0,
        thinkingLevelMap: I,
        input: ["text", "image"],
        cost: at,
        contextWindow: 5e5,
        maxTokens: 32768,
      },
    ],
  });
}
import {
  LlmAdapter as pr,
  ReasoningEffortId as _,
  attributionHeaders as cr,
} from "@deepseek-ai/dsh-llm";
import {
  createAssistantMessage as Wr,
  createToolResultMessage as Gr,
  createUserMessage as jr,
} from "@deepseek-ai/dsh-llm";
var te = "sparkAssistant",
  Rt = "__sparkPiRequest",
  Pt = "sparkEvent",
  wt = new WeakMap();
function E(t) {
  return t[Rt];
}
function ke(t) {
  let e = E(t);
  return e
    ? e.context
    : {
        ...(t.system ? { systemPrompt: t.system } : {}),
        messages: t.messages.flatMap(Ot),
        ...(t.tools
          ? {
              tools: t.tools.map((r) => ({
                name: r.name,
                description: r.description,
                parameters: r.parameters,
              })),
            }
          : {}),
      };
}
function ve(t) {
  let e = E(t);
  return e
    ? e.model
    : {
        id: t.model,
        name: t.model,
        api: "openai-completions",
        provider: t.provider,
        baseUrl: "",
        reasoning: !!t.reasoningEffort,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128e3,
        maxTokens: t.maxTokens ?? 4096,
      };
}
function xe(t) {
  let e = E(t);
  return e
    ? e.options
    : {
        ...(t.signal ? { signal: t.signal } : {}),
        ...(t.maxTokens !== void 0 ? { maxTokens: t.maxTokens } : {}),
        ...(t.reasoningEffort ? { reasoning: t.reasoningEffort } : {}),
      };
}
async function* be(t) {
  let e = !1;
  for await (let n of t)
    if ((yield* _t(n), n.type === "done" || n.type === "error")) {
      e = !0;
      return;
    }
  if (e) return;
  let r = await t.result();
  r && (yield* Ct(r));
}
function h(t, e) {
  return (wt.set(t, e), (t[Pt] = e), t);
}
function It(t) {
  return "contentIndex" in t ? t.contentIndex : 0;
}
function Et(t) {
  if (!("partial" in t) || !t.partial || !("contentIndex" in t)) return;
  let e = t.partial.content[t.contentIndex];
  if (e?.type === "toolCall") return e.id;
}
function* _t(t) {
  let e = It(t);
  switch (t.type) {
    case "start":
      yield h({ type: "text-delta", index: 0, text: "" }, t);
      return;
    case "text_start":
      yield h({ type: "block-start", index: e, blockType: "text" }, t);
      return;
    case "text_delta":
      yield h({ type: "text-delta", index: e, text: t.delta }, t);
      return;
    case "text_end":
      yield h({ type: "block-end", index: e, block: { type: "text", text: t.content } }, t);
      return;
    case "thinking_start":
      yield h({ type: "block-start", index: e, blockType: "reasoning" }, t);
      return;
    case "thinking_delta":
      yield h({ type: "reasoning-delta", index: e, text: t.delta }, t);
      return;
    case "thinking_end":
      yield h({ type: "block-end", index: e, block: { type: "reasoning", text: t.content } }, t);
      return;
    case "toolcall_start":
    case "toolcall_delta": {
      let r = Et(t) ?? `spark-tool-${String(e)}`;
      yield h(
        {
          type: "tool-call-delta",
          index: e,
          id: r,
          argumentsDelta: t.type === "toolcall_delta" ? t.delta : "",
        },
        t,
      );
      return;
    }
    case "toolcall_end":
      yield h(
        {
          type: "block-end",
          index: e,
          block: {
            type: "tool-call",
            id: t.toolCall.id,
            name: t.toolCall.name,
            arguments: JSON.stringify(t.toolCall.arguments ?? {}),
          },
        },
        t,
      );
      return;
    case "done":
      (yield Me(t.message),
        yield h(
          { type: "finish", reason: Re(t.message), replayState: { response: { [te]: t.message } } },
          t,
        ));
      return;
    case "error":
      yield h(Nt(t.error), t);
      return;
  }
}
function Ot(t) {
  if (t.role === "assistant")
    return [
      {
        role: "assistant",
        content: Tt(t.content),
        api: "openai-completions",
        provider: t.source.kind === "model" ? t.source.provider : "spark",
        model: t.source.kind === "model" ? t.source.model : "unknown",
        usage: Ut(),
        stopReason: "stop",
        timestamp: Date.now(),
      },
    ];
  let e = t.content.find((r) => r.type === "tool-result");
  return e && e.type === "tool-result"
    ? [
        {
          role: "toolResult",
          toolCallId: e.toolCallId,
          toolName: "",
          content: e.content.map((r) =>
            r.type === "text" ? { type: "text", text: r.text } : { type: "text", text: "" },
          ),
          isError: !!e.isError,
          timestamp: Date.now(),
        },
      ]
    : [
        {
          role: "user",
          content: t.content
            .filter((r) => r.type === "text")
            .map((r) => (r.type === "text" ? r.text : "")).join(`
`),
          timestamp: Date.now(),
        },
      ];
}
function Tt(t) {
  let e = [];
  for (let r of t)
    (r.type === "text" && e.push({ type: "text", text: r.text }),
      r.type === "reasoning" && e.push({ type: "thinking", thinking: r.text }),
      r.type === "tool-call" &&
        e.push({ type: "toolCall", id: r.id, name: r.name, arguments: Dt(r.arguments) }));
  return e;
}
function* Ct(t, e) {
  let r = 0;
  for (let o of t.content) {
    if (o.type === "text")
      (yield { type: "block-start", index: r, blockType: "text" },
        yield { type: "text-delta", index: r, text: o.text },
        yield { type: "block-end", index: r, block: { type: "text", text: o.text } });
    else if (o.type === "thinking") {
      let i = "thinking" in o && typeof o.thinking == "string" ? o.thinking : "";
      (yield { type: "block-start", index: r, blockType: "reasoning" },
        yield { type: "reasoning-delta", index: r, text: i },
        yield { type: "block-end", index: r, block: { type: "reasoning", text: i } });
    } else if (o.type === "toolCall") {
      let i = o,
        s = JSON.stringify(i.arguments ?? {});
      (yield { type: "block-start", index: r, blockType: "tool-call" },
        yield { type: "tool-call-delta", index: r, id: i.id, name: i.name, argumentsDelta: s },
        yield {
          type: "block-end",
          index: r,
          block: { type: "tool-call", id: i.id, name: i.name, arguments: s },
        });
    }
    r += 1;
  }
  yield Me(t);
  let n = { type: "finish", reason: Re(t), replayState: { response: { [te]: t } } };
  yield e ? h(n, e) : n;
}
function Me(t) {
  return {
    type: "usage",
    usage: {
      inputTokens: t.usage?.input ?? 0,
      outputTokens: t.usage?.output ?? 0,
      ...(t.usage?.cacheRead !== void 0 ? { cacheReadTokens: t.usage.cacheRead } : {}),
      ...(t.usage?.cacheWrite !== void 0 ? { cacheWriteTokens: t.usage.cacheWrite } : {}),
    },
  };
}
function Nt(t) {
  return {
    type: "finish",
    reason: {
      kind: t.stopReason === "aborted" ? "aborted" : "error",
      failure: {
        message: t.errorMessage?.trim() || "provider error",
        code: t.stopReason === "aborted" ? "ABORTED" : "PROVIDER",
      },
    },
    replayState: { response: { [te]: t } },
  };
}
function Re(t) {
  return t.stopReason === "toolUse"
    ? { kind: "tool-calls" }
    : t.stopReason === "length"
      ? { kind: "max-tokens" }
      : t.stopReason === "aborted"
        ? {
            kind: "aborted",
            failure: { message: t.errorMessage?.trim() || "aborted", code: "ABORTED" },
          }
        : t.stopReason === "error"
          ? {
              kind: "error",
              failure: { message: t.errorMessage?.trim() || "provider error", code: "PROVIDER" },
            }
          : { kind: "stop" };
}
function Ut() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
function Dt(t) {
  if (!t) return {};
  try {
    let e = JSON.parse(t);
    return e && typeof e == "object" && !Array.isArray(e) ? e : {};
  } catch {
    return {};
  }
}
import { createAssistantMessageEventStream as qt } from "@earendil-works/pi-ai";
var k = class extends Error {
    issues;
    constructor(e) {
      (super(`Invalid SparkModelProfile: ${e.join("; ")}`),
        (this.name = "SparkModelValidationError"),
        (this.issues = e));
    }
  },
  B = class {
    #e = new Map();
    constructor(e = []) {
      for (let r of e) this.add(r);
    }
    get size() {
      return this.#e.size;
    }
    add(e) {
      let r = Ie(e);
      if (this.#e.has(r.id)) throw new k([`duplicate Spark model profile id: ${r.id}`]);
      return (this.#e.set(r.id, r), r);
    }
    addMany(e) {
      for (let r of e) this.add(r);
    }
    get(e) {
      return this.#e.get(e);
    }
    require(e) {
      let r = this.get(e);
      if (!r) throw new k([`unknown Spark model profile id: ${e}`]);
      return r;
    }
    has(e) {
      return this.#e.has(e);
    }
    list() {
      return [...this.#e.values()];
    }
  };
function Ie(t) {
  let e = Kt(t);
  if (e.length > 0) throw new k(e);
  return t;
}
function ne(t, e) {
  let r = Ie(t);
  if (!r.routes.some((n) => n.id === e.id))
    throw new k([`route ${e.id} does not belong to Spark model profile: ${r.id}`]);
  return {
    id: e.transportModelId,
    name: e.label ? `${r.name} (${e.label})` : r.name,
    api: e.transportApi,
    provider: e.provider,
    baseUrl: e.baseUrl,
    reasoning: r.capabilities.reasoning,
    input: [...r.capabilities.input],
    cost: { ...r.cost },
    contextWindow: r.contextWindow,
    maxTokens: r.maxTokens,
    ...(r.thinkingLevelMap !== void 0 ? { thinkingLevelMap: r.thinkingLevelMap } : {}),
    ...(e.headers !== void 0 ? { headers: e.headers } : {}),
    ...(e.compat !== void 0 ? { compat: e.compat } : {}),
  };
}
function Ee(t) {
  return {
    api: t.identity?.api ?? "spark-ai",
    provider: t.identity?.provider ?? "spark-ai",
    model: t.identity?.model ?? t.id,
  };
}
function R(t, e) {
  return { ...t, api: e.api, provider: e.provider, model: e.model };
}
function Lt(t, e) {
  return t.type === "done"
    ? { ...t, message: R(t.message, e) }
    : t.type === "error"
      ? { ...t, error: R(t.error, e) }
      : { ...t, partial: R(t.partial, e) };
}
function _e(t, e) {
  return {
    async *[Symbol.asyncIterator]() {
      for await (let r of t) yield Lt(r, e);
    },
    async result() {
      return R(await t.result(), e);
    },
  };
}
var re = class {
    #e;
    #t;
    #n;
    #o;
    #i;
    #a;
    #r = new Map();
    constructor(e, r = {}) {
      if (!e.slots.length) throw new k([`auth pool ${e.id} has no slots`]);
      ((this.#e = e),
        (this.#t = r.clock ?? { now: () => Date.now() }),
        (this.#n = r.baseCooldownMs ?? 3e4),
        (this.#o = r.maxCooldownMs ?? 5 * 6e4),
        (this.#i = r.stateTtlMs ?? 30 * 6e4),
        (this.#a = r.maxStateEntries ?? 256));
    }
    selectSlot() {
      this.#p();
      let e = this.#e.slots.filter((s) => s.enabled !== !1);
      if (!e.length) throw new k([`auth pool ${this.#e.id} has no enabled slots`]);
      let r = this.#t.now(),
        n = e.filter((s) => !this.#u(s.id, r)),
        o = n.length ? this.#d(n) : this.#s(e, r),
        i = this.#l(o.slot.id, r);
      return (
        (i.inflight += 1),
        (i.lastUsedAtMs = r),
        (i.lastTouchedAtMs = r),
        {
          poolId: this.#e.id,
          slotId: o.slot.id,
          slot: o.slot,
          reason: n.length ? "available" : "all_slots_cooled_fail_open",
          cooledDown: !n.length,
          ...(o.cooldownUntilMs !== void 0
            ? { cooldownUntil: new Date(o.cooldownUntilMs).toISOString() }
            : {}),
        }
      );
    }
    recordSuccess(e) {
      let r = this.#t.now(),
        n = this.#l(e, r);
      ((n.inflight = Math.max(0, n.inflight - 1)),
        (n.consecutiveFailures = 0),
        delete n.cooldownUntilMs,
        delete n.lastFailureClass,
        (n.lastTouchedAtMs = r));
    }
    recordFailure(e, r) {
      let n = this.#t.now(),
        o = Bt(r),
        i = P[o],
        s = this.#l(e, n);
      ((s.inflight = Math.max(0, s.inflight - 1)),
        (s.consecutiveFailures += 1),
        (s.lastFailureClass = o),
        (s.lastTouchedAtMs = n),
        i.cooldown && (s.cooldownUntilMs = n + this.#c(s.consecutiveFailures)));
    }
    snapshot() {
      let e = this.#t.now();
      return (
        this.#p(),
        {
          id: this.#e.id,
          slots: this.#e.slots.map((r) => {
            let n = this.#r.get(r.id),
              o = n?.cooldownUntilMs;
            return {
              id: r.id,
              authRefHash: $t(r.authRef),
              priority: r.priority,
              enabled: r.enabled !== !1,
              inflight: n?.inflight ?? 0,
              consecutiveFailures: n?.consecutiveFailures ?? 0,
              health: this.#f(r, n, e),
              ...(n?.lastUsedAtMs !== void 0
                ? { lastUsedAt: new Date(n.lastUsedAtMs).toISOString() }
                : {}),
              ...(o !== void 0 ? { cooldownUntil: new Date(o).toISOString() } : {}),
              ...(n?.lastFailureClass !== void 0 ? { lastFailureClass: n.lastFailureClass } : {}),
            };
          }),
        }
      );
    }
    #d(e) {
      return { slot: [...e].sort(we(this.#r))[0] };
    }
    #s(e, r) {
      return [...e]
        .map((n) => {
          let o = this.#r.get(n.id)?.cooldownUntilMs;
          return o !== void 0 ? { slot: n, cooldownUntilMs: o } : { slot: n };
        })
        .sort((n, o) => {
          let i = n.cooldownUntilMs ?? r,
            s = o.cooldownUntilMs ?? r;
          return i !== s ? i - s : we(this.#r)(n.slot, o.slot);
        })[0];
    }
    #u(e, r) {
      let n = this.#r.get(e)?.cooldownUntilMs;
      return n !== void 0 && n > r;
    }
    #l(e, r) {
      let n = this.#r.get(e);
      return (
        n || ((n = { inflight: 0, consecutiveFailures: 0, lastTouchedAtMs: r }), this.#r.set(e, n)),
        n
      );
    }
    #c(e) {
      return T(e, this.#n, this.#o);
    }
    #f(e, r, n) {
      return e.enabled === !1
        ? "disabled"
        : r?.cooldownUntilMs !== void 0 && r.cooldownUntilMs > n
          ? "cooldown"
          : r?.lastFailureClass === "auth"
            ? "stale_auth"
            : r?.lastFailureClass === "transient"
              ? "degraded"
              : "ok";
    }
    #p() {
      let e = this.#t.now(),
        r = new Set(this.#e.slots.map((n) => n.id));
      for (let [n, o] of this.#r) {
        if (!r.has(n)) {
          this.#r.delete(n);
          continue;
        }
        let i = o.lastTouchedAtMs ?? o.lastUsedAtMs ?? e;
        e - i > this.#i && o.inflight <= 0 && this.#r.delete(n);
      }
      for (; this.#r.size > this.#a;) {
        let n = [...this.#r.entries()].sort(
          (o, i) =>
            (o[1].lastTouchedAtMs ?? o[1].lastUsedAtMs ?? e) -
            (i[1].lastTouchedAtMs ?? i[1].lastUsedAtMs ?? e),
        )[0]?.[0];
        if (!n) break;
        this.#r.delete(n);
      }
    }
  },
  $ = class extends Error {
    trace;
    constructor(e, r) {
      (super(e), (this.name = "SparkRouteResolutionError"), (this.trace = r));
    }
  },
  K = class extends Error {
    classification;
    trace;
    constructor(e, r, n) {
      (super(e),
        (this.name = "SparkRouteExecutionError"),
        (this.classification = r),
        (this.trace = n));
    }
  },
  W = class {
    #e;
    #t;
    #n;
    #o = new Map();
    #i = new Map();
    constructor(e, r = {}) {
      ((this.#e = e),
        (this.#t = r.clock ?? { now: () => Date.now() }),
        (this.#n = r.traceMaxEvents ?? 32));
    }
    resolve(e) {
      let r = new G(e.traceMaxEvents ?? this.#n, this.#t);
      return this.#r(e, new Set(e.excludeRouteIds ?? []), r);
    }
    async executeWithFailover(e, r) {
      return this.#a(e, r, { failover: !0 });
    }
    async executeOnce(e, r) {
      return this.#a(e, r, { failover: !1 });
    }
    async #a(e, r, n) {
      let o = new G(e.traceMaxEvents ?? this.#n, this.#t),
        i = new Set(e.excludeRouteIds ?? []),
        s;
      for (;;) {
        let d = this.#r(e, i, o);
        try {
          let a = ne(this.#e.require(e.sparkModelId), d.route),
            l = await r({ decision: d, model: a, trace: o.snapshot() }),
            p = Pe(d);
          return (
            this.#d(this.#e.require(e.sparkModelId), d.authPoolId).recordSuccess(p),
            this.#u(e, d.routeId),
            o.add("REQUEST_FINAL", e.sparkModelId, {
              routeId: d.routeId,
              authPoolId: d.authPoolId,
              authSlotId: p,
              reason: "ok",
            }),
            { result: l, decision: { ...d, trace: o.snapshot() }, trace: o.snapshot() }
          );
        } catch (a) {
          let l = A(a);
          s = l;
          let p = Pe(d);
          if (
            (this.#d(this.#e.require(e.sparkModelId), d.authPoolId).recordFailure(p, l),
            o.add("REQUEST_FINAL", e.sparkModelId, {
              routeId: d.routeId,
              authPoolId: d.authPoolId,
              authSlotId: p,
              reason: l.failureClass,
            }),
            this.#l(e, d.routeId),
            !n.failover || !l.policy.failover)
          )
            throw new K(
              `Spark route ${d.routeId} failed with ${l.failureClass}: ${l.message}`,
              l,
              o.snapshot(),
            );
          i.add(d.routeId);
        }
      }
      throw new K(
        "Spark route execution failed without an available failover route.",
        s ?? A("unknown provider failure"),
        o.snapshot(),
      );
    }
    #r(e, r, n) {
      let o = this.#e.require(e.sparkModelId),
        i = [...o.routes]
          .filter((a) => a.enabled !== !1)
          .sort((a, l) => l.priority - a.priority || a.id.localeCompare(l.id));
      n.add("CANDIDATE_POOL", o.id, {
        reason: `candidates:${i.length}`,
        details: { routeIds: i.map((a) => a.id) },
      });
      let s = this.#s(e) ? this.#o.get(this.#s(e)) : void 0,
        d = s ? [...i.filter((a) => a.id === s), ...i.filter((a) => a.id !== s)] : i;
      for (let a of d) {
        if (r.has(a.id)) {
          n.add("CANDIDATE_SKIP", o.id, { routeId: a.id, reason: "excluded" });
          continue;
        }
        let l = Ft(o, e);
        if (l) {
          n.add("CANDIDATE_SKIP", o.id, { routeId: a.id, reason: l });
          continue;
        }
        let p;
        try {
          p = this.#d(o, a.authPoolId).selectSlot();
        } catch (m) {
          n.add("CANDIDATE_SKIP", o.id, {
            routeId: a.id,
            authPoolId: a.authPoolId,
            reason: m instanceof Error ? m.message : "auth pool unavailable",
          });
          continue;
        }
        let u = a.id === s ? "sticky_available" : "ordered_available";
        n.add("CANDIDATE_START", o.id, {
          routeId: a.id,
          authPoolId: a.authPoolId,
          authSlotId: p.slotId,
          reason: u,
        });
        let f = {
          profileId: o.id,
          routeId: a.id,
          authPoolId: a.authPoolId,
          authSlotId: p.slotId,
          reason: u,
          route: a,
          authSlot: p.slot,
          sticky: a.id === s,
          trace: n.snapshot(),
        };
        return (this.#u(e, a.id), f);
      }
      throw new $(`No available route for Spark model ${o.id}`, n.snapshot());
    }
    #d(e, r) {
      let n = `${e.id}:${r}`,
        o = this.#i.get(n);
      if (o) return o;
      let i = e.authPools?.find((d) => d.id === r);
      if (!i) throw new k([`unknown auth pool for route: ${r}`]);
      let s = new re(i, { clock: this.#t });
      return (this.#i.set(n, s), s);
    }
    authPoolSnapshots() {
      return [...this.#i.values()].map((e) => e.snapshot());
    }
    #s(e) {
      let r = e.workflowRunId ?? e.sessionId;
      return r ? `${e.sparkModelId}:${r}` : void 0;
    }
    #u(e, r) {
      let n = this.#s(e);
      n && this.#o.set(n, r);
    }
    #l(e, r) {
      let n = this.#s(e);
      n && this.#o.get(n) === r && this.#o.delete(n);
    }
  };
function Pe(t) {
  if (!t.authSlotId) throw new $(`Route ${t.routeId} did not resolve an auth slot`, t.trace);
  return t.authSlotId;
}
var G = class {
  #e = [];
  maxEvents;
  clock;
  constructor(e, r) {
    ((this.maxEvents = e), (this.clock = r));
  }
  add(e, r, n = {}) {
    for (
      this.#e.push({ type: e, at: new Date(this.clock.now()).toISOString(), profileId: r, ...n });
      this.#e.length > this.maxEvents;
    )
      this.#e.shift();
  }
  snapshot() {
    return { events: [...this.#e], maxEvents: this.maxEvents };
  }
};
function Ft(t, e) {
  let r = e.capabilities?.input ?? [];
  for (let n of r) if (!t.capabilities.input.includes(n)) return `capability_mismatch:input:${n}`;
  if ((e.reasoning === !0 || e.capabilities?.reasoning === !0) && !t.capabilities.reasoning)
    return "capability_mismatch:reasoning";
  if (e.capabilities?.toolUse === !0 && t.capabilities.toolUse !== !0)
    return "capability_mismatch:toolUse";
}
function Bt(t) {
  if (typeof t == "string" && t in P) return t;
  if (y(t) && typeof t.failureClass == "string") {
    let e = t.failureClass;
    if (e in P) return e;
  }
  return A(t).failureClass;
}
function we(t) {
  return (e, r) => {
    if (e.priority !== r.priority) return r.priority - e.priority;
    let n = t.get(e.id)?.inflight ?? 0,
      o = t.get(r.id)?.inflight ?? 0;
    if (n !== o) return n - o;
    let i = t.get(e.id)?.lastUsedAtMs ?? 0,
      s = t.get(r.id)?.lastUsedAtMs ?? 0;
    return i !== s ? i - s : e.id.localeCompare(r.id);
  };
}
function $t(t) {
  let e =
      t.kind === "env"
        ? `env:${t.name}`
        : t.kind === "secret"
          ? `secret:${t.id}`
          : `provider:${t.id}`,
    r = 2166136261;
  for (let n = 0; n < e.length; n += 1) ((r ^= e.charCodeAt(n)), (r = Math.imul(r, 16777619)));
  return `fnv1a:${(r >>> 0).toString(16).padStart(8, "0")}`;
}
function Kt(t) {
  let e = [];
  return y(t)
    ? (g(t, "id", "profile.id", e),
      g(t, "name", "profile.name", e),
      Gt(t.capabilities, e),
      jt(t.cost, e),
      M(t, "contextWindow", "profile.contextWindow", e),
      M(t, "maxTokens", "profile.maxTokens", e),
      Wt(t.identity, e),
      zt(t.routes, t.authPools, e),
      Yt(t.authPools, e),
      e)
    : ["profile must be an object"];
}
function Wt(t, e) {
  if (t !== void 0) {
    if (!y(t)) {
      e.push("profile.identity must be an object when present");
      return;
    }
    (t.api !== void 0 && g(t, "api", "profile.identity.api", e),
      t.provider !== void 0 && g(t, "provider", "profile.identity.provider", e),
      t.model !== void 0 && g(t, "model", "profile.identity.model", e));
  }
}
function Gt(t, e) {
  if (!y(t)) {
    e.push("profile.capabilities must be an object");
    return;
  }
  if (!Array.isArray(t.input) || t.input.length === 0)
    e.push("profile.capabilities.input must be a non-empty array");
  else
    for (let [r, n] of t.input.entries())
      n !== "text" &&
        n !== "image" &&
        e.push(`profile.capabilities.input[${r}] must be text or image`);
  (typeof t.reasoning != "boolean" && e.push("profile.capabilities.reasoning must be a boolean"),
    t.toolUse !== void 0 &&
      typeof t.toolUse != "boolean" &&
      e.push("profile.capabilities.toolUse must be a boolean when present"));
}
function jt(t, e) {
  if (!y(t)) {
    e.push("profile.cost must be an object");
    return;
  }
  (M(t, "input", "profile.cost.input", e),
    M(t, "output", "profile.cost.output", e),
    M(t, "cacheRead", "profile.cost.cacheRead", e),
    M(t, "cacheWrite", "profile.cost.cacheWrite", e));
}
function zt(t, e, r) {
  if (!Array.isArray(t) || t.length === 0) {
    r.push("profile.routes must be a non-empty array");
    return;
  }
  let n = new Set(),
    o = new Set();
  if (Array.isArray(e))
    for (let i of e) y(i) && typeof i.id == "string" && i.id.trim() && o.add(i.id.trim());
  for (let [i, s] of t.entries()) {
    let d = `profile.routes[${i}]`;
    if (!y(s)) {
      r.push(`${d} must be an object`);
      continue;
    }
    let a = g(s, "id", `${d}.id`, r);
    (a && (n.has(a) && r.push(`duplicate route id in profile.routes: ${a}`), n.add(a)),
      g(s, "provider", `${d}.provider`, r),
      g(s, "transportApi", `${d}.transportApi`, r),
      g(s, "transportModelId", `${d}.transportModelId`, r),
      g(s, "baseUrl", `${d}.baseUrl`, r));
    let l = g(s, "authPoolId", `${d}.authPoolId`, r);
    (l && !o.has(l) && r.push(`${d}.authPoolId references unknown auth pool: ${l}`),
      Oe(s, "priority", `${d}.priority`, r),
      s.enabled !== void 0 &&
        typeof s.enabled != "boolean" &&
        r.push(`${d}.enabled must be a boolean when present`),
      s.headers !== void 0 &&
        !Vt(s.headers) &&
        r.push(`${d}.headers must be a record of strings when present`));
  }
}
function Yt(t, e) {
  if (t === void 0) return;
  if (!Array.isArray(t)) {
    e.push("profile.authPools must be an array when present");
    return;
  }
  let r = new Set();
  for (let [n, o] of t.entries()) {
    let i = `profile.authPools[${n}]`;
    if (!y(o)) {
      e.push(`${i} must be an object`);
      continue;
    }
    let s = g(o, "id", `${i}.id`, e);
    if (
      (s && (r.has(s) && e.push(`duplicate auth pool id in profile.authPools: ${s}`), r.add(s)),
      !Array.isArray(o.slots) || o.slots.length === 0)
    ) {
      e.push(`${i}.slots must be a non-empty array`);
      continue;
    }
    let d = new Set();
    for (let [a, l] of o.slots.entries()) {
      let p = `${i}.slots[${a}]`;
      if (!y(l)) {
        e.push(`${p} must be an object`);
        continue;
      }
      let u = g(l, "id", `${p}.id`, e);
      (u && (d.has(u) && e.push(`duplicate auth slot id in ${i}.slots: ${u}`), d.add(u)),
        Oe(l, "priority", `${p}.priority`, e),
        Ht(l.authRef, `${p}.authRef`, e),
        l.enabled !== void 0 &&
          typeof l.enabled != "boolean" &&
          e.push(`${p}.enabled must be a boolean when present`));
    }
  }
}
function Ht(t, e, r) {
  if (!y(t)) {
    r.push(`${e} must be an object`);
    return;
  }
  if (t.kind === "env") {
    g(t, "name", `${e}.name`, r);
    return;
  }
  if (t.kind === "secret" || t.kind === "provider") {
    g(t, "id", `${e}.id`, r);
    return;
  }
  r.push(`${e}.kind must be env, secret, or provider`);
}
function g(t, e, r, n) {
  let o = t[e];
  if (typeof o != "string" || !o.trim()) {
    n.push(`${r} must be a non-empty string`);
    return;
  }
  return o.trim();
}
function M(t, e, r, n) {
  let o = t[e];
  if (typeof o != "number" || !Number.isFinite(o) || o < 0) {
    n.push(`${r} must be a non-negative finite number`);
    return;
  }
  return o;
}
function Oe(t, e, r, n) {
  let o = t[e];
  if (typeof o != "number" || !Number.isFinite(o)) {
    n.push(`${r} must be a finite number`);
    return;
  }
  return o;
}
function y(t) {
  return !!t && typeof t == "object" && !Array.isArray(t);
}
function Vt(t) {
  return y(t) ? Object.values(t).every((e) => typeof e == "string") : !1;
}
import { randomUUID as Jt } from "node:crypto";
function Te() {
  return Jt();
}
function j(t, e) {
  try {
    t?.(e);
  } catch {}
}
var Xt = Number.MAX_SAFE_INTEGER,
  Ce = 64;
function Ne(t, e = {}) {
  return (r, n, o) => {
    let i = t.getActive();
    if (!i) throw new Error("No active Spark model selected");
    return Qt(t, i, n, o, e);
  };
}
function Qt(t, e, r, n, o = {}, i = {}) {
  let s = t.getProvider(e.providerName);
  if (!s) throw new Error(`Unknown provider: ${e.providerName}`);
  let d = t.buildProfile(e.providerName, e.modelId),
    l = new W(new B([d])).resolve({
      sparkModelId: d.id,
      ...(n?.sessionId !== void 0 ? { sessionId: n.sessionId } : {}),
    }),
    p = ne(d, l.route),
    u = Ee(d),
    f = o.resolveApiKey?.(s, e);
  return ir(p, f, (m) => {
    let c = rr(p.api, tr(er(dr(n, m)))),
      v = () => Zt(() => lr(s.streamSimple(p, r, c), e.providerName), e, i, u),
      Fe = C(v(), v, {
        providerName: e.providerName,
        maxRetries: e.providerName === "baidu-oneapi" ? 0 : 1,
        maxRetryDelayMs: 1,
        ...(c?.signal !== void 0 ? { signal: c.signal } : {}),
        shouldRetry: (V) => A(V).failureClass === "transient",
        shouldRetryThrown: (V) => A(V).failureClass === "transient",
      });
    return _e(Fe, u);
  });
}
function Zt(t, e, r, n) {
  let o = r.observeProviderAttempt;
  if (!o) return t();
  let i = (r.createAttemptId ?? Te)(),
    s = (r.now ?? Date.now)(),
    d;
  try {
    d = t();
  } catch (u) {
    throw (
      j(o, {
        attemptId: i,
        outcome: "missing",
        provider: e.providerName,
        model: e.modelId,
        observedAt: s,
      }),
      u
    );
  }
  let a = !1,
    l = (u) => {
      a || ((a = !0), j(o, { attemptId: i, outcome: "response", message: R(u, n), observedAt: s }));
    },
    p = () => {
      a ||
        ((a = !0),
        j(o, {
          attemptId: i,
          outcome: "missing",
          provider: e.providerName,
          model: e.modelId,
          observedAt: s,
        }));
    };
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (let u of d)
          (u.type === "done" && l(u.message), u.type === "error" && l(u.error), yield u);
        a || p();
      } catch (u) {
        throw (p(), u);
      }
    },
    async result() {
      try {
        let u = await d.result();
        return (l(u), u);
      } catch (u) {
        throw (p(), u);
      }
    },
  };
}
function er(t) {
  return !t?.signal || t.maxRetries !== void 0 ? t : { ...t, maxRetries: Xt };
}
function tr(t) {
  let e = Ue(t);
  return e
    ? {
        ...(t ?? {}),
        prompt_cache_key: e,
        metadata: { ...(t?.metadata ?? {}), prompt_cache_key: e },
      }
    : t;
}
function rr(t, e) {
  if (t !== "openai-responses" || e?.sessionId !== void 0 || e?.cacheRetention === "none") return e;
  let r = or(Ue(e));
  if (!r) return e;
  let n = e?.onPayload;
  return {
    ...(e ?? {}),
    onPayload: async (o, i) => {
      let s = nr(o) ? { ...o, prompt_cache_key: r } : o;
      return (await n?.(s, i)) ?? s;
    },
  };
}
function nr(t) {
  return typeof t == "object" && t !== null && !Array.isArray(t);
}
function Ue(t) {
  let e = t?.prompt_cache_key;
  if (typeof e == "string" && e.trim()) return e.trim();
  let r = t?.promptCacheKey;
  if (typeof r == "string" && r.trim()) return r.trim();
  let o = t?.metadata?.prompt_cache_key;
  return typeof o == "string" && o.trim() ? o.trim() : void 0;
}
function or(t) {
  if (t === void 0) return;
  let e = Array.from(t);
  return e.length <= Ce ? t : e.slice(0, Ce).join("");
}
function ir(t, e, r) {
  if (!ar(e)) return r(e);
  let n = qt();
  return (
    e
      .then(async (o) => {
        let i = r(o);
        for await (let s of i) n.push(s);
        n.end();
      })
      .catch((o) => {
        n.push({ type: "error", reason: "error", error: sr(t, o) });
      }),
    n
  );
}
function sr(t, e) {
  return {
    role: "assistant",
    content: [],
    api: t.api,
    provider: t.provider,
    model: t.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: e instanceof Error ? e.message : String(e),
    timestamp: Date.now(),
  };
}
function ar(t) {
  return typeof t?.then == "function";
}
function dr(t, e) {
  return e === void 0 || t?.apiKey !== void 0 ? t : { ...t, apiKey: e };
}
function lr(t, e) {
  if (!ur(t)) throw new Error(`Provider "${e}" returned a non-async-iterable stream`);
  if (typeof t.result == "function") return t;
  let n;
  return {
    async *[Symbol.asyncIterator]() {
      for await (let o of t)
        (o.type === "done" && (n = o.message), o.type === "error" && (n = o.error), yield o);
    },
    async result() {
      if (n) return n;
      for await (let o of t) {
        if (o.type === "done") return o.message;
        if (o.type === "error") return o.error;
      }
      throw new Error(`Provider "${e}" stream ended without a final assistant message`);
    },
  };
}
function ur(t) {
  return !!t && typeof t == "object" && typeof t[Symbol.asyncIterator] == "function";
}
var fr = [
    { id: _("minimal"), name: "Minimal" },
    { id: _("low"), name: "Low" },
    { id: _("medium"), name: "Medium" },
    { id: _("high"), name: "High" },
    { id: _("xhigh"), name: "Extra high" },
  ],
  z = class extends pr {
    #e;
    #t;
    #n;
    constructor(e, r, n = {}) {
      (super(), (this.#e = e), (this.#t = r), (this.#n = n));
    }
    providerInfo(e) {
      let r = this.#e.getProvider(this.#t);
      return { id: e, name: r?.label ?? r?.name ?? e };
    }
    async listModels(e) {
      return this.#e
        .listModelsFor(this.#t)
        .map((r) => ({ provider: e, id: r.id, name: r.name, inputModalities: r.input }));
    }
    async resolveModel(e, r) {
      let n = this.#e.listModelsFor(this.#t).find((o) => o.id === r || o.aliases?.includes(r));
      return {
        provider: e,
        id: r,
        name: n?.name ?? r,
        ...(n
          ? {
              context: { contextWindow: n.contextWindow },
              defaultMaxTokens: n.maxTokens,
              ...(n.reasoning ? { reasoning: { efforts: fr } } : {}),
            }
          : {}),
      };
    }
    async *stream(e) {
      cr();
      let r = E(e),
        n = r?.model ?? ve(e),
        o = r?.context ?? ke(e),
        i = r?.options ?? xe(e);
      this.#e.setActive({ providerName: e.provider, modelId: e.model });
      let s = Ne(this.#e, this.#n)(n, o, i);
      yield* be(s);
    }
  };
var Y = class {
  #e = new Map();
  #t;
  registerProvider(e, r) {
    if (!e) throw new Error("SparkProviderRegistry.registerProvider requires a provider name");
    if (typeof r?.streamSimple != "function")
      throw new Error(
        `Provider plugin "${e}" must expose a streamSimple function (Model, Context, options) => stream`,
      );
    if (!Array.isArray(r.models) || r.models.length === 0)
      throw new Error(`Provider plugin "${e}" must declare at least one model`);
    this.#e.set(e, { ...r, name: e, label: r.label ?? r.name });
  }
  hasProvider(e) {
    return this.#e.has(e);
  }
  getProvider(e) {
    return this.#e.get(e);
  }
  listProviders() {
    return [...this.#e.values()];
  }
  listModelsFor(e) {
    return this.#e.get(e)?.models ?? [];
  }
  setActive(e) {
    let { def: r } = this.#n(e.providerName, e.modelId);
    this.#t = { providerName: e.providerName, modelId: r.id };
  }
  getActive() {
    return this.#t ? { ...this.#t } : void 0;
  }
  buildActiveModel() {
    if (this.#t) return this.buildModel(this.#t.providerName, this.#t.modelId);
  }
  buildModel(e, r) {
    let { provider: n, def: o } = this.#n(e, r);
    return {
      id: o.id,
      name: o.name,
      api: o.api ?? n.api,
      provider: e,
      baseUrl: o.baseUrl ?? n.baseUrl,
      reasoning: o.reasoning,
      input: [...o.input],
      cost: { ...o.cost },
      contextWindow: o.contextWindow,
      maxTokens: o.maxTokens,
      ...(o.thinkingLevelMap !== void 0 ? { thinkingLevelMap: o.thinkingLevelMap } : {}),
    };
  }
  buildProfile(e, r) {
    let { provider: n, def: o } = this.#n(e, r),
      i = `${e}:auth`;
    return {
      id: `${e}/${o.id}`,
      name: o.name,
      capabilities: { input: [...o.input], reasoning: o.reasoning },
      cost: { ...o.cost },
      contextWindow: o.contextWindow,
      maxTokens: o.maxTokens,
      ...(o.thinkingLevelMap !== void 0 ? { thinkingLevelMap: o.thinkingLevelMap } : {}),
      identity: { api: n.api, provider: e, model: o.id },
      routes: [
        {
          id: `${e}/${o.id}`,
          provider: e,
          priority: 0,
          transportApi: o.transportApi ?? o.api ?? n.api,
          transportModelId: o.transportModelId ?? o.id,
          baseUrl: o.transportBaseUrl ?? o.baseUrl ?? n.baseUrl,
          authPoolId: i,
        },
      ],
      authPools: [{ id: i, slots: [{ id: `${e}:default`, priority: 0, authRef: gr(n) }] }],
    };
  }
  #n(e, r) {
    let n = this.#e.get(e);
    if (!n) throw new Error(`Unknown provider: ${e}`);
    let o = n.models.find((i) => mr(i, r));
    if (!o) throw new Error(`Provider "${e}" has no model with id "${r}"`);
    return { provider: n, def: o };
  }
};
function mr(t, e) {
  return t.id === e || (t.aliases ?? []).includes(e);
}
function gr(t) {
  let e = t.apiKey ?? t.name;
  return /^[A-Z0-9_]+$/u.test(e)
    ? { kind: "env", name: e }
    : { kind: "provider", id: `${t.name}:auth` };
}
var Mr = "spark-llm",
  Rr = ["llm"],
  x = "baidu-oneapi",
  Pr = "BAIDU_ONEAPI_API_KEY",
  De = hr("spark-llm"),
  wr = O.object({ apiKeyEnv: O.string().role("credential-ref"), displayName: O.string() }),
  Le = O.object({ providers: O.dict(wr).default({}) });
async function Ir(t, e) {
  let r = t.get("credentials");
  if (r !== void 0) {
    let i = await r.resolve(e);
    if (i !== void 0 && i.value.length > 0) return i.value;
  }
  let n = process.env[e];
  if (n !== void 0 && n.length > 0) return n;
  let o = Or(_r(), [x, e]);
  if (o !== void 0) return o;
}
function Er(t, e) {
  if (typeof t != "object" || t === null) return;
  let r = t;
  if (!(r.version !== 1 || typeof r.credentials != "object" || r.credentials === null))
    for (let n of e) {
      let o = r.credentials[n];
      if (
        o !== void 0 &&
        o.type === "api_key" &&
        typeof o.apiKey == "string" &&
        o.apiKey.length > 0
      )
        return o.apiKey;
    }
}
function _r() {
  let t = xr(),
    e = [],
    r = process.env.SPARK_HOME;
  r !== void 0 && r.length > 0 && e.push(H(r, "auth.json"));
  let n = process.env.XDG_CONFIG_HOME;
  return (
    n !== void 0 && n.length > 0 && e.push(H(n, "spark", "auth.json")),
    e.push(H(t, ".config", "spark", "auth.json")),
    e.push(H(t, ".spark", "auth.json")),
    e
  );
}
function Or(t, e) {
  for (let r of t) {
    let n;
    try {
      n = br(r, "utf8");
    } catch {
      continue;
    }
    let o;
    try {
      o = JSON.parse(n);
    } catch {
      continue;
    }
    let i = Er(o, e);
    if (i !== void 0) return i;
  }
}
function Tr(t, e) {
  let r = ge({ anthropicMessages: kr(), openAIResponses: he(vr()) }),
    n = new Y();
  r.register(n);
  let o = () => e,
    i = () => o().providers,
    s = new z(n, x, {
      resolveApiKey: async (f) => {
        let c = i()[x]?.apiKeyEnv ?? f.apiKey ?? Pr,
          v = await Ir(t, c);
        if (v !== void 0) return Sr(v, "spark-llm", c);
      },
    }),
    d;
  d === void 0 && (d = t.llm.registerAdapter([x], s));
  let l,
    p,
    u = () => {
      let f = i()[x],
        m = [
          {
            provider: x,
            displayName: f?.displayName ?? "Baidu OneAPI",
            settingsNs: De,
            settingsPath: ["providers", x],
            declared: !1,
          },
        ];
      Ar(m, p) ||
        (l === void 0 ? (l = t.llm.registerConfigurableProviders(m)) : l.replace(m), (p = m));
    };
  (u(),
    yr(t, De, Le, e, {
      setSource: (f) => {
        o = f;
      },
      onChange: () => {
        try {
          u();
        } catch (f) {
          (t.logger.error(
            "spark-llm: keeping the previous configurable-provider directory after a refused update",
          ),
            t.logger.error(f));
        }
      },
    }));
}
var Sn = { name: Mr, inject: Rr, apply: Tr, Config: Le };
export {
  x as BAIDU_ONEAPI_PROVIDER,
  Le as Config,
  Tr as apply,
  Sn as default,
  Rr as inject,
  Mr as name,
  Er as sparkAuthApiKey,
  Or as sparkAuthApiKeyFromFiles,
  _r as sparkAuthCandidates,
};
