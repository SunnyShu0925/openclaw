/* @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import {
  renderDevicesContainer,
  getDevicesSection as getSection,
} from "../../test-helpers/devices-view.tsx";

function findButton(scope: Element, label: string): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button ${label}`);
  }
  return button;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("pending pairing action deduplication", () => {
  it("disables approve when its action is pending and leaves reject enabled", () => {
    const container = renderDevicesContainer({
      devicesList: {
        pending: [
          {
            requestId: "req-1",
            deviceId: "pending-device",
            displayName: "Pending device",
            roles: ["operator"],
            scopes: ["operator.read"],
          },
        ],
        paired: [],
      },
      pendingPairingActions: new Set(["device:req-1:approve"]),
    });
    const section = getSection(container, "Pending approval");
    expect(findButton(section, "Approve").disabled).toBe(true);
    expect(findButton(section, "Reject").disabled).toBe(false);
  });

  it("does not disable approve when a different action is pending", () => {
    const container = renderDevicesContainer({
      devicesList: {
        pending: [
          {
            requestId: "req-3",
            deviceId: "pending-device",
            displayName: "Pending device",
            roles: ["operator"],
            scopes: ["operator.read"],
          },
        ],
        paired: [],
      },
      pendingPairingActions: new Set(["device:other-request:approve"]),
    });
    const section = getSection(container, "Pending approval");
    expect(findButton(section, "Approve").disabled).toBe(false);
    expect(findButton(section, "Reject").disabled).toBe(false);
  });
});

it("disables reject when its action is pending and leaves approve enabled", () => {
  const container = renderDevicesContainer({
    devicesList: {
      pending: [
        {
          requestId: "req-2",
          deviceId: "pending-device",
          displayName: "Pending device",
          roles: ["operator"],
          scopes: ["operator.read"],
        },
      ],
      paired: [],
    },
    pendingPairingActions: new Set(["device:req-2:reject"]),
  });
  const section = getSection(container, "Pending approval");
  expect(findButton(section, "Reject").disabled).toBe(true);
  expect(findButton(section, "Approve").disabled).toBe(false);
});
