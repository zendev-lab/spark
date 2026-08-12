import { fail, redirect } from "@sveltejs/kit";
import { getDictionary, localeCookieName, resolveRequestLocale } from "$lib/i18n";
import { formText } from "$lib/server/form-data";
import { requireSecretRequestContext } from "$lib/server/secret-request-context";
import {
  cancelProviderOAuthForHub,
  getProviderOAuthFlowForHub,
  loadModelControlForHub,
  loadProjectedModelControlForHub,
  logoutProviderForHub,
  parseModelValue,
  respondProviderOAuthForHub,
  setDefaultModelForHub,
  setProviderApiKeyForHub,
  startProviderOAuthForHub,
  testModelForHub,
} from "$lib/server/model-control";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ parent, url }) => {
  const layout = await parent();
  const workspaceId = layout.activeWorkspace?.id ?? "";
  const workspaceSlug = layout.activeWorkspace?.slug ?? "";
  const route = { workspaceId };
  let control = await loadProjectedModelControlForHub(route);
  if (!control.available) {
    control = await loadModelControlForHub({ ...route, timeoutMs: 2_000 });
  }
  const flowId = url.searchParams.get("flow")?.trim() || null;
  let flow = null;
  let flowError: string | null = null;
  if (flowId && control.available) {
    try {
      flow = await getProviderOAuthFlowForHub(flowId, route);
    } catch (error) {
      flowError = errorMessage(error);
    }
  }
  return { control, flow, flowError, workspaceId, workspaceSlug };
};

export const actions: Actions = {
  setDefaultModel: async ({ cookies, request }) => {
    const form = await request.formData();
    const copy = actionCopy(cookies.get(localeCookieName), request.headers.get("accept-language"));
    try {
      await setDefaultModelForHub(parseModelValue(formText(form, "model")), workspaceRoute(form));
      return { intent: "setDefaultModel", success: true, message: copy.defaultUpdated };
    } catch (error) {
      return fail(400, actionError("setDefaultModel", error));
    }
  },

  testModel: async ({ cookies, request }) => {
    const form = await request.formData();
    const copy = actionCopy(cookies.get(localeCookieName), request.headers.get("accept-language"));
    try {
      const test = await testModelForHub(
        parseModelValue(formText(form, "model")),
        workspaceRoute(form),
      );
      return {
        intent: "testModel",
        success: test.status === "reachable",
        message:
          test.status === "reachable"
            ? copy.connectivitySucceeded.replace("{latency}", String(test.latencyMs))
            : copy.connectivityFailed,
        test,
      };
    } catch (error) {
      return fail(400, actionError("testModel", error));
    }
  },

  refreshCatalog: async ({ cookies, request }) => {
    const form = await request.formData();
    const copy = actionCopy(cookies.get(localeCookieName), request.headers.get("accept-language"));
    const control = await loadModelControlForHub({ ...workspaceRoute(form), timeoutMs: 10_000 });
    if (!control.available) return fail(503, actionError("refreshCatalog", control.error));
    return { intent: "refreshCatalog", success: true, message: copy.catalogRefreshed };
  },

  saveApiKey: async (event) => {
    const { cookies, request } = event;
    const form = await request.formData();
    const copy = actionCopy(cookies.get(localeCookieName), request.headers.get("accept-language"));
    const providerName = formText(form, "providerName").trim();
    const apiKey = formText(form, "apiKey");
    try {
      await setProviderApiKeyForHub(
        providerName,
        apiKey,
        requireSecretRequestContext(event),
        workspaceRoute(form),
      );
      return { intent: "saveApiKey", success: true, message: copy.credentialSaved };
    } catch (error) {
      return fail(400, actionError("saveApiKey", error));
    }
  },

  logout: async ({ cookies, request }) => {
    const form = await request.formData();
    const copy = actionCopy(cookies.get(localeCookieName), request.headers.get("accept-language"));
    try {
      await logoutProviderForHub(formText(form, "providerName").trim(), workspaceRoute(form));
      return { intent: "logout", success: true, message: copy.credentialRemoved };
    } catch (error) {
      return fail(400, actionError("logout", error));
    }
  },

  startOAuth: async ({ request, url }) => {
    const form = await request.formData();
    let flowId: string;
    try {
      const flow = await startProviderOAuthForHub(
        formText(form, "providerName").trim(),
        workspaceRoute(form),
      );
      flowId = flow.id;
    } catch (error) {
      return fail(400, actionError("startOAuth", error));
    }
    redirect(303, flowUrl(url, flowId));
  },

  respondOAuth: async (event) => {
    const { request, url } = event;
    const form = await request.formData();
    const flowId = formText(form, "flowId").trim();
    try {
      await respondProviderOAuthForHub(
        flowId,
        formText(form, "promptId").trim(),
        formText(form, "response"),
        requireSecretRequestContext(event),
        workspaceRoute(form),
      );
    } catch (error) {
      return fail(400, actionError("respondOAuth", error));
    }
    redirect(303, flowUrl(url, flowId));
  },

  cancelOAuth: async ({ request, url }) => {
    const form = await request.formData();
    try {
      await cancelProviderOAuthForHub(formText(form, "flowId").trim(), workspaceRoute(form));
    } catch (error) {
      return fail(400, actionError("cancelOAuth", error));
    }
    const next = new URL("/settings/models", url);
    next.searchParams.delete("flow");
    redirect(303, `${next.pathname}${next.search}`);
  },
};

function actionError(intent: string, error: unknown) {
  return { intent, success: false, message: errorMessage(error) };
}

function workspaceRoute(form: FormData): { workspaceId: string } {
  return { workspaceId: formText(form, "workspaceId").trim() };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function flowUrl(url: URL, flowId: string): string {
  const next = new URL("/settings/models", url);
  next.searchParams.set("flow", flowId);
  return `${next.pathname}${next.search}`;
}

function actionCopy(cookieLocale: string | undefined, acceptLanguage: string | null) {
  const locale = resolveRequestLocale({ cookieLocale, acceptLanguage });
  return getDictionary(locale).modelSettings.actions;
}
