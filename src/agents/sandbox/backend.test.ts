// Sandbox backend registry tests cover pluggable backend factory and manager
// lifecycle hooks.
import { describe, expect, it } from "vitest";
import {
  getSandboxBackendCanonicalStaging,
  getSandboxBackendFactory,
  getSandboxBackendManager,
  getSandboxBackendWorkdirResolver,
  registerSandboxBackend,
} from "./backend.js";

describe("sandbox backend registry", () => {
  it("registers Podman as a built-in backend", () => {
    expect(getSandboxBackendFactory("podman")).not.toBeNull();
    expect(getSandboxBackendManager("podman")).not.toBeNull();
    expect(getSandboxBackendWorkdirResolver("podman")).not.toBeNull();
  });

  it("registers and restores backend factories", () => {
    // Tests and optional backends install process-local factories; restore must
    // remove them so later suites see the default registry.
    const factory = async () => {
      throw new Error("not used");
    };
    const restore = registerSandboxBackend("test-backend", factory);
    expect(getSandboxBackendFactory("test-backend")).toBe(factory);
    restore();
    expect(getSandboxBackendFactory("test-backend")).toBeNull();
  });

  it("registers backend managers alongside factories", () => {
    const factory = async () => {
      throw new Error("not used");
    };
    const manager = {
      describeRuntime: async () => ({
        running: true,
        configLabelMatch: true,
      }),
      removeRuntime: async () => {},
    };
    const restore = registerSandboxBackend("test-managed", {
      factory,
      manager,
    });
    expect(getSandboxBackendFactory("test-managed")).toBe(factory);
    expect(getSandboxBackendManager("test-managed")).toBe(manager);
    restore();
    expect(getSandboxBackendManager("test-managed")).toBeNull();
  });

  it("registers backend workdir resolvers alongside factories", () => {
    const factory = async () => {
      throw new Error("not used");
    };
    const resolveWorkdir = () => "/runtime/workspace";
    const restore = registerSandboxBackend("test-workdir", {
      factory,
      resolveWorkdir,
    });
    expect(getSandboxBackendWorkdirResolver("test-workdir")).toBe(resolveWorkdir);
    restore();
    expect(getSandboxBackendWorkdirResolver("test-workdir")).toBeNull();
  });

  it("declares remote canonical staging for SSH and defaults unknown backends to local", () => {
    expect(getSandboxBackendCanonicalStaging("ssh")).toBe("remote");
    expect(getSandboxBackendCanonicalStaging("docker")).toBe("local");
    expect(getSandboxBackendCanonicalStaging("unknown-backend")).toBe("local");
  });

  it("registers the canonical staging declaration alongside factories", () => {
    const factory = async () => {
      throw new Error("not used");
    };
    const restore = registerSandboxBackend("test-staging", {
      factory,
      canonicalStaging: "remote",
    });
    expect(getSandboxBackendCanonicalStaging("test-staging")).toBe("remote");
    restore();
    expect(getSandboxBackendCanonicalStaging("test-staging")).toBe("local");
  });
});
