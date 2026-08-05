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
});
