import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/auth/session", () => ({
  getAuthenticatedSession: vi.fn().mockResolvedValue({
    access_token: "test-access-token",
  }),
}));

vi.mock("../src/resources/config/config", () => ({
  default: {
    supabaseClient: {
      auth: {},
    },
  },
}));

import {
  signalDecisionReport,
  signalReturnReport,
} from "../src/services/plaid/plaidService";

describe("plaid signal endpoint construction", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
  });

  it("signalDecisionReport uses SUPABASE_FUNCTIONS_URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ request_id: "req-1" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await signalDecisionReport({
      clientTransactionId: "txn-123",
      initiated: true,
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/functions/v1/signal-decision-report");
    expect(options).toEqual(
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  it("signalReturnReport uses SUPABASE_FUNCTIONS_URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ request_id: "req-2" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await signalReturnReport({
      clientTransactionId: "txn-123",
      returnCode: "R01",
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/functions/v1/signal-return-report");
    expect(options).toEqual(
      expect.objectContaining({
        method: "POST",
      })
    );
  });
});
