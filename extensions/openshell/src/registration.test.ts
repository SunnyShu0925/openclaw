import { getSandboxBackendCanonicalStaging } from "openclaw/plugin-sdk/sandbox";
// Openshell registration tests cover the backend capability contract declared
// by the plugin entrypoint.
import { afterEach, describe, expect, it } from "vitest";
import pluginEntry from "../index.js";

function registerWithMode(mode?: unknown): void {
  pluginEntry.register({
    registrationMode: "full",
    pluginConfig: mode === undefined ? undefined : { mode },
  } as never);
}

describe("openshell sandbox backend registration", () => {
  afterEach(() => {
    // Restore the default (mirror) declaration so later tests see the normal
    // plugin registration.
    registerWithMode();
  });

  it("declares remote canonical staging in remote mode", () => {
    registerWithMode("remote");
    expect(getSandboxBackendCanonicalStaging("openshell")).toBe("remote");
  });

  it("declares local canonical staging in mirror mode (the default)", () => {
    registerWithMode("mirror");
    expect(getSandboxBackendCanonicalStaging("openshell")).toBe("local");
    registerWithMode();
    expect(getSandboxBackendCanonicalStaging("openshell")).toBe("local");
  });
});
