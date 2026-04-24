// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import theme from "../src/theme";

const getOrCreateVisitorIdMock = vi.fn(() => "visitor-test-id");

vi.mock("../src/utils/visitorId", () => ({
  getOrCreateVisitorId: () => getOrCreateVisitorIdMock(),
}));

vi.mock("../src/components/ChatPaymentModal", () => ({
  ChatPaymentModal: () => null,
}));

import { InvestorChatWidget } from "../src/components/InvestorChatWidget";

describe("InvestorChatWidget history payload", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Element.prototype.scrollIntoView = vi.fn();

    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("chat-check-access")) {
        return {
          ok: true,
          json: async () => ({
            canChat: true,
            needsPayment: false,
            accessType: "free",
            messagesRemaining: 10,
            messagesUsed: 0,
            totalFreeMessages: 10,
          }),
        };
      }

      if (url.includes("investor-chat")) {
        return {
          ok: true,
          json: async () => ({
            reply: "ok",
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({}),
      };
    });

    vi.stubGlobal("fetch", fetchMock);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("includes the just-sent user message in investor-chat history payload", async () => {
    await act(async () => {
      root.render(
        React.createElement(
          ChakraProvider,
          { theme },
          React.createElement(InvestorChatWidget, {
            slug: "jane-doe",
            investorName: "Jane Doe",
          })
        )
      );
    });
    await flush();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(textarea).toBeTruthy();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      valueSetter?.call(textarea, "First message");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      textarea!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    await act(async () => {
      textarea!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    await flush();

    const investorChatCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("investor-chat")
    );
    expect(investorChatCall).toBeTruthy();

    const requestInit = investorChatCall?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(requestInit?.body || "{}"));

    expect(body.message).toBe("First message");
    expect(body.history).toEqual([
      {
        role: "user",
        content: "First message",
      },
    ]);
  });
});

