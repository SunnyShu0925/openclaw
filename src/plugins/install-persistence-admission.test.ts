// Regression coverage for install persistence when manifest admission rejects a plugin.
import { beforeEach, describe, expect, it } from "vitest";
import {
  enablePluginInConfig,
  loadPluginManifestRegistry,
  resetPluginsCliTestState,
  writeConfigFile,
  writePersistedInstalledPluginIndexInstallRecordsWithLease,
} from "../cli/plugins-cli-test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";

function requireMockCallArg(
  mockFn: { mock: { calls: unknown[][] } },
  label: string,
  index = 0,
): Record<string, unknown> {
  const arg = mockFn.mock.calls[index]?.[0] as Record<string, unknown> | undefined;
  if (!arg) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return arg;
}

const installWriteOptions = {
  assertConfigPathForWrite: () => {},
  expectedConfigPath: "/tmp/openclaw.json",
  ownedConfigPathForWrite: "/tmp/openclaw.json",
};

describe("persistPluginInstall manifest admission", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  it("rejects a plugin whose manifest admission failed instead of persisting it as ready", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const baseConfig = {
      plugins: {
        allow: ["memory-core"],
        entries: {},
      },
    } as OpenClawConfig;
    // A structurally invalid configSchema is rejected at manifest admission: the plugin
    // is absent from registry.plugins and appears only as an error diagnostic. The install
    // path must not map that absence to "ready" and write a successful install record.
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [],
      diagnostics: [
        {
          level: "error",
          pluginId: "broken-schema-plugin",
          message:
            "plugin manifest configSchema is invalid: <schema>.properties.mode.$ref: unresolved ref",
          source: "/tmp/broken-schema-plugin/openclaw.plugin.json",
        },
      ],
    });

    await expect(
      persistPluginInstall({
        snapshot: {
          config: baseConfig,
          baseHash: "config-1",
          writeOptions: installWriteOptions,
        },
        pluginId: "broken-schema-plugin",
        install: {
          source: "npm",
          spec: "broken-schema-plugin@1.0.0",
          installPath: "/tmp/broken-schema-plugin",
        },
      }),
    ).rejects.toThrow("has invalid configured settings");

    expect(enablePluginInConfig).not.toHaveBeenCalled();
    expect(writePersistedInstalledPluginIndexInstallRecordsWithLease).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("does not reject a valid install when an unrelated setup error shares the plugin id", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const baseConfig = {
      plugins: {
        allow: ["memory-core"],
        entries: {},
      },
    } as OpenClawConfig;
    // A plugin can be admitted into registry.plugins (valid manifest) while a coexisting
    // setup-resolution error (e.g. missing runtime setup entry) shares its id in
    // registry.diagnostics. The admission-error branch must not fire here: the manifest is
    // present with no configSchema requirements, so install must proceed (ready) rather than
    // throw "has invalid configured settings". Uses enable:false to exercise the ready branch
    // without depending on the runtime slot-selection/snapshot path.
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "shared-id-plugin",
          manifestPath: "/tmp/shared-id-plugin/openclaw.plugin.json",
          configSchema: { type: "object", additionalProperties: false },
        },
      ],
      diagnostics: [
        {
          level: "error",
          pluginId: "shared-id-plugin",
          message: "runtime setup entry not found",
          source: "/tmp/shared-id-plugin",
        },
      ],
    });

    await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
        writeOptions: installWriteOptions,
      },
      pluginId: "shared-id-plugin",
      enable: false,
      install: {
        source: "npm",
        spec: "shared-id-plugin@1.0.0",
        installPath: "/tmp/shared-id-plugin",
      },
    });

    // Install proceeded as ready (not rejected as invalid) and persisted an install record.
    // The key assertion is that persistPluginInstall did NOT throw "has invalid configured
    // settings" - proving the coexisting setup-error diagnostic did not trigger the
    // admission-error branch when the manifest was admitted.
    expect(enablePluginInConfig).not.toHaveBeenCalled();
    const persistedRecords = requireMockCallArg(
      writePersistedInstalledPluginIndexInstallRecordsWithLease,
      "writePersistedInstalledPluginIndexInstallRecordsWithLease",
    );
    expect(persistedRecords["shared-id-plugin"]).toMatchObject({
      source: "npm",
      spec: "shared-id-plugin@1.0.0",
      installPath: "/tmp/shared-id-plugin",
    });
  });
});
