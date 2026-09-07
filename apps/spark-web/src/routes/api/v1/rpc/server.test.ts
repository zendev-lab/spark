import { expect, test, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("$lib/server/rpc", () => ({
  invokeSparkWebRpc: invoke,
  SparkWebRpcForbiddenError: class extends Error {},
}));
import { POST } from "./+server.ts";

const call = (request: Request) => POST({ request } as Parameters<typeof POST>[0]);

test("aborted uploads do not dispatch an RPC or become server errors", async () => {
  const request = new Request("http://localhost/api/v1/rpc", { method: "POST", body: "{}" });
  vi.spyOn(request, "json").mockRejectedValueOnce(
    Object.assign(new Error("aborted"), { code: "ECONNRESET" }),
  );
  expect((await call(request)).status).toBe(499);
  expect(invoke).not.toHaveBeenCalled();
});

test.each(["{broken", "null", "[]", "1", "{}"])(
  "malformed RPC body %s is a client error",
  async (body) => {
    await expect(
      call(new Request("http://localhost/api/v1/rpc", { method: "POST", body })),
    ).rejects.toMatchObject({ status: 400 });
    expect(invoke).not.toHaveBeenCalled();
  },
);

test("unrelated body-read failures remain observable", async () => {
  const request = new Request("http://localhost/api/v1/rpc", { method: "POST", body: "{}" });
  vi.spyOn(request, "json").mockRejectedValueOnce(new Error("unexpected read failure"));
  await expect(call(request)).rejects.toThrow("unexpected read failure");
});
