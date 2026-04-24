// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createLinkTokenMock = vi.fn();
const exchangeTokenMock = vi.fn();
const fetchAllFinancialDataMock = vi.fn();
const checkAssetReportMock = vi.fn();
const saveFinancialDataToSupabaseMock = vi.fn();
const signalPrepareMock = vi.fn();

vi.mock("../src/services/plaid/plaidService", () => ({
  createLinkToken: (...args: unknown[]) => createLinkTokenMock(...args),
  exchangeToken: (...args: unknown[]) => exchangeTokenMock(...args),
  fetchAllFinancialData: (...args: unknown[]) => fetchAllFinancialDataMock(...args),
  checkAssetReport: (...args: unknown[]) => checkAssetReportMock(...args),
  saveFinancialDataToSupabase: (...args: unknown[]) =>
    saveFinancialDataToSupabaseMock(...args),
  signalPrepare: (...args: unknown[]) => signalPrepareMock(...args),
  getProductStatus: (product: { available: boolean; data?: { status?: string } | null }) => {
    if (product.available) return "success";
    if (product.data?.status === "pending") return "pending";
    return "idle";
  },
}));

vi.mock("react-plaid-link", () => ({
  usePlaidLink: ({
    token,
    onSuccess,
  }: {
    token: string | null;
    onSuccess: (publicToken: string, metadata: unknown) => void;
  }) => ({
    ready: Boolean(token),
    open: () =>
      onSuccess("public-token", {
        institution: { name: "Test Bank", institution_id: "ins_1" },
      }),
  }),
}));

import { usePlaidLinkHook } from "../src/services/plaid/usePlaidLink";

function HookHarness() {
  const { openPlaidLink, retry } = usePlaidLinkHook("user-123", "test@hushh.ai");

  return React.createElement(
    "div",
    null,
    React.createElement(
      "button",
      { type: "button", "data-testid": "open", onClick: openPlaidLink },
      "open"
    ),
    React.createElement(
      "button",
      { type: "button", "data-testid": "retry", onClick: retry },
      "retry"
    )
  );
}

describe("usePlaidLinkHook retry polling cleanup", () => {
  let container: HTMLDivElement;
  let root: Root;

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    window.history.replaceState({}, "", "/onboarding/financial-link");

    createLinkTokenMock.mockResolvedValue({
      link_token: "link-token-123",
      expiration: "2099-01-01T00:00:00Z",
    });
    exchangeTokenMock.mockResolvedValue({
      access_token: "access-token",
      item_id: "item-1",
    });
    fetchAllFinancialDataMock.mockResolvedValue({
      status: "partial",
      balance: { available: true, data: {}, error: null, reason: null },
      assets: {
        available: false,
        data: { status: "pending", asset_report_token: "asset-token" },
        error: null,
        reason: null,
      },
      investments: { available: false, data: null, error: null, reason: "not_supported" },
      identity: { available: false, data: null, error: null, reason: "not_supported" },
      authNumbers: { available: false, data: null, error: null, reason: "not_supported" },
      identityMatch: { available: false, data: null, error: null, reason: "not_supported" },
      summary: { products_available: 1, products_total: 6, can_proceed: true },
    });
    checkAssetReportMock.mockResolvedValue({
      status: "pending",
    });
    signalPrepareMock.mockResolvedValue({ success: true });
    saveFinancialDataToSupabaseMock.mockResolvedValue(undefined);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it("stops stale asset polling after retry", async () => {
    await act(async () => {
      root.render(React.createElement(HookHarness));
    });
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await flush();

    await act(async () => {
      container
        .querySelector('[data-testid="open"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await flush();
    expect(checkAssetReportMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      container
        .querySelector('[data-testid="retry"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(15000);
    });
    await flush();

    expect(checkAssetReportMock).toHaveBeenCalledTimes(1);
  });
});
