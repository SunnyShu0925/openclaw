import { describe, expect, it } from "vitest";
import { resolvePackageRuntimePreflight } from "./update-command-service-plan.js";

describe("resolvePackageRuntimePreflight", () => {
  it("refers to the printed engine range in the upgrade hint", async () => {
    const result = await resolvePackageRuntimePreflight({
      target: { version: "2027.1.0", nodeEngine: ">=90.2.0 <91 || >=92.5.0" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("The requested package requires >=90.2.0 <91 || >=92.5.0.");
    expect(result.error).toContain(
      "Upgrade to a Node runtime that satisfies the engine range above",
    );
  });

  it("does not suggest a version excluded by an upper bound", async () => {
    const result = await resolvePackageRuntimePreflight({
      target: { version: "2027.1.0", nodeEngine: ">=28.0.0 <29" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain(">=28.0.0 <29");
    expect(result.error).not.toContain("28.0.0+");
  });
});
