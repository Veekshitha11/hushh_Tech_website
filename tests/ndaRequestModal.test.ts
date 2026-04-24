// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import theme from "../src/theme";

const requestFileAccessMock = vi.fn();

vi.mock("../src/services/access/accessControlApi", () => ({
  requestFileAccess: (...args: unknown[]) => requestFileAccessMock(...args),
}));

vi.mock("react-phone-input-2", () => ({
  default: ({
    value,
    onChange,
  }: {
    value?: string;
    onChange: (value: string) => void;
  }) =>
    React.createElement("input", {
      "data-testid": "phone-input",
      value: value || "",
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        onChange(event.target.value),
    }),
}));

import NDARequestModal from "../src/components/NDARequestModal";

describe("NDARequestModal duplicate submit guard", () => {
  let container: HTMLDivElement;
  let root: Root;

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  const setInputValue = async (selector: string, value: string) => {
    const input = container.querySelector(selector) as HTMLInputElement | null;
    expect(input).toBeTruthy();
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      valueSetter?.call(input, value);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      input!.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };

  const clickButtonByText = async (text: string) => {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes(text)
    ) as HTMLButtonElement | undefined;
    expect(button).toBeTruthy();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("calls requestFileAccess only once while a submit is pending", async () => {
    let resolveRequest: ((value: string) => void) | null = null;
    requestFileAccessMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveRequest = resolve;
        })
    );

    await act(async () => {
      root.render(
        React.createElement(
          ChakraProvider,
          { theme },
          React.createElement(NDARequestModal, {
            session: { access_token: "token-123" },
            onSubmit: vi.fn(),
            isOpen: true,
          })
        )
      );
    });
    await flush();

    await setInputValue('input[placeholder="Enter your full name"]', "Jane Doe");
    await setInputValue(
      'input[placeholder="Enter your state for taxation"]',
      "California"
    );
    await setInputValue('input[placeholder="Enter your city for taxation"]', "San Jose");
    await setInputValue(
      'input[placeholder="Enter your country for taxation"]',
      "United States"
    );
    await setInputValue('input[placeholder="Enter your address"]', "1 Main Street");
    await setInputValue(
      'input[placeholder="Enter your legal email"]',
      "jane@example.com"
    );
    await setInputValue('input[data-testid="phone-input"]', "1234567890");

    await clickButtonByText("Continue to NDA Review");
    await flush();
    expect(container.textContent).toContain("Review and Sign Non-Disclosure Agreement");

    const ndaCheckboxes = container.querySelectorAll(
      'input[type="checkbox"]'
    ) as NodeListOf<HTMLInputElement>;
    expect(ndaCheckboxes.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      ndaCheckboxes[0].click();
      ndaCheckboxes[1].click();
    });
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button")).find(
      (candidate) =>
        candidate.textContent?.includes("Submit NDA & Investor Profile")
    ) as HTMLButtonElement | undefined;
    expect(submitButton).toBeTruthy();

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(requestFileAccessMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRequest?.("Pending");
      await Promise.resolve();
    });
  });
});
