// Session store target resolution for the per-agent deterministic store hot path.
import nodeFs from "node:fs";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config.js";
import { replaceSessionEntry } from "./session-accessor.sqlite-entry.js";
import { resolveExistingAgentSessionStoreTargetsSync } from "./targets.js";
import { createAgentSessionStores, createCustomRootCfg } from "./targets.test-support.js";

describe("resolveExistingAgentSessionStoreTargetsSync deterministic store", () => {
  it("does not touch other agents' store files when the deterministic store exists", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const storePaths = await createAgentSessionStores(stateDir, ["ops", "retired"]);
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "ops", default: true }] },
      };
      const readdirSpy = vi.spyOn(nodeFs, "readdirSync");
      const lstatSpy = vi.spyOn(nodeFs, "lstatSync");
      const realpathSpy = vi.spyOn(nodeFs.realpathSync, "native");

      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "ops", { env: process.env })).toEqual(
        [{ agentId: "ops", storePath: storePaths.ops }],
      );
      // Configured agents take the bounded canonical path, which resolves the store directly
      // without listing the agents directory. No retired agent store file is ever statted or
      // realpathed on the hot path — the bounded path never reaches directory discovery.
      expect(readdirSpy).toHaveBeenCalledTimes(0);
      const touched = [...lstatSpy.mock.calls, ...realpathSpy.mock.calls]
        .map(([firstArg]) => (typeof firstArg === "string" ? firstArg : ""))
        .filter((candidate) => candidate.includes("retired"));
      expect(touched).toEqual([]);
      readdirSpy.mockRestore();
      lstatSpy.mockRestore();
      realpathSpy.mockRestore();
    });
  });

  it("falls back to directory discovery when the deterministic store is missing", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const storePaths = await createAgentSessionStores(stateDir, ["ops"]);
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "ops", default: true }] },
        session: {
          store: path.join(home, "external", "sessions-{agentId}.json"),
        },
      };

      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "ops", { env: process.env })).toEqual(
        [{ agentId: "ops", storePath: storePaths.ops }],
      );
    });
  });

  it("keeps an alternate same-agent store in another root visible when the deterministic store exists", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const customRoot = path.join(home, "custom-state");
      const customStorePaths = await createAgentSessionStores(customRoot, ["ops"]);
      const defaultStorePaths = await createAgentSessionStores(stateDir, ["ops"]);
      const cfg = createCustomRootCfg(customRoot);

      const targets = resolveExistingAgentSessionStoreTargetsSync(cfg, "ops", {
        env: process.env,
      });

      expect(targets.map((target) => target.storePath).toSorted()).toEqual(
        [customStorePaths.ops!, defaultStorePaths.ops!].toSorted(),
      );
    });
  });

  it("does not discover a non-round-tripping same-agent alias directory for a configured agent", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const storePaths = await createAgentSessionStores(stateDir, ["ops"]);
      const aliasStorePaths = await createAgentSessionStores(stateDir, ["Ops"]);
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "ops", default: true }] },
      };

      const targets = resolveExistingAgentSessionStoreTargetsSync(cfg, "ops", {
        env: process.env,
      });

      // Configured agents take the bounded canonical path, which resolves only the configured
      // agent's own store. A same-root alias directory whose name does not round-trip through
      // normalizeAgentId (e.g. "Ops" vs "ops") is intentionally not recovered — that cross-alias
      // visibility is out of scope for the bounded-discovery contract and was never part of main's
      // configured-agent path. Only the configured "ops" store is returned.
      expect(targets.map((target) => target.storePath).toSorted()).toEqual(
        [storePaths.ops!].toSorted(),
      );
      expect(targets.map((target) => target.storePath)).not.toContain(aliasStorePaths.Ops);
    });
  });

  it("does not discover a configured agent's store under another configured agent's template root", async () => {
    // A template may carry {agentId} before the final agents/<agentId> segment, so each configured
    // agent expansion resolves a distinct agents root and an alternate same-agent store may live
    // under another agent's root (e.g. the ops store under the work expansion). The bounded
    // configured-agent path does not enumerate other expansions, so that cross-root store is
    // intentionally not recovered — recovering it would require scanning one root per configured
    // agent, which is exactly the O(configured agents) fan-out issue #123439 reports.
    await withTempHome(async (home) => {
      const storesRoot = path.join(home, "stores");
      const cfg: OpenClawConfig = {
        session: {
          store: path.join(
            storesRoot,
            "{agentId}",
            "agents",
            "{agentId}",
            "sessions",
            "sessions.json",
          ),
        },
        agents: { list: [{ id: "ops", default: true }, { id: "work" }] },
      };
      // Deterministic ops store under the ops expansion.
      const deterministicStorePath = path.join(
        storesRoot,
        "ops",
        "agents",
        "ops",
        "sessions",
        "sessions.json",
      );
      // Alternate ops store under the work expansion — not visible under the bounded contract.
      const alternateStorePath = path.join(
        storesRoot,
        "work",
        "agents",
        "ops",
        "sessions",
        "sessions.json",
      );
      await replaceSessionEntry(
        { storePath: deterministicStorePath, sessionKey: "main" },
        { sessionId: "sid-deterministic", updatedAt: 1 },
      );
      await replaceSessionEntry(
        { storePath: alternateStorePath, sessionKey: "main" },
        { sessionId: "sid-alternate", updatedAt: 2 },
      );

      const targets = resolveExistingAgentSessionStoreTargetsSync(cfg, "ops", {
        env: process.env,
      });

      expect(targets.map((target) => target.storePath).toSorted()).toEqual(
        [path.resolve(deterministicStorePath)].toSorted(),
      );
      expect(targets.map((target) => target.storePath)).not.toContain(
        path.resolve(alternateStorePath),
      );
    });
  });

  it("discovers a retired/manual agent's store under another configured agent's template root", async () => {
    // A template may carry {agentId} before the final agents/<agentId> segment, so each configured
    // agent expansion resolves a distinct agents root. A non-configured (retired/manual) agent has
    // no canonical path, and its persisted store may live under another configured agent's
    // expansion (e.g. the retired "old" store under the work expansion). Non-configured discovery
    // enumerates every configured expansion plus the default root — the same root set main's
    // all-agent discovery searches — so that cross-root store stays visible after configuration
    // removal. Only the requested agent's directories are validated, so other agents' stores are
    // never statted on this path.
    await withTempHome(async (home) => {
      const storesRoot = path.join(home, "stores");
      const cfg: OpenClawConfig = {
        session: {
          store: path.join(
            storesRoot,
            "{agentId}",
            "agents",
            "{agentId}",
            "sessions",
            "sessions.json",
          ),
        },
        agents: { list: [{ id: "ops", default: true }, { id: "work" }] },
      };
      // Retired "old" store under the work expansion — the cross-root case main preserves.
      const retiredStorePath = path.join(
        storesRoot,
        "work",
        "agents",
        "old",
        "sessions",
        "sessions.json",
      );
      await replaceSessionEntry(
        { storePath: retiredStorePath, sessionKey: "main" },
        { sessionId: "sid-retired-cross-root", updatedAt: 1 },
      );

      const targets = resolveExistingAgentSessionStoreTargetsSync(cfg, "old", {
        env: process.env,
      });

      expect(targets.map((target) => target.storePath)).toContain(path.resolve(retiredStorePath));
      expect(targets.map((target) => target.agentId)).toContain("old");
    });
  });

  it("does not discover same-agent alias directories for a configured agent under an external template", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      // Two alias directories that both normalize to "ops", but the requested agent is configured.
      const lowerStorePaths = await createAgentSessionStores(stateDir, ["ops"]);
      const upperStorePaths = await createAgentSessionStores(stateDir, ["Ops"]);
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "ops", default: true }] },
        session: {
          store: path.join(home, "external", "sessions-{agentId}.json"),
        },
      };

      const targets = resolveExistingAgentSessionStoreTargetsSync(cfg, "ops", {
        env: process.env,
      });

      // Configured agents take the bounded canonical path even under an external template: the
      // default-root store is resolved directly, and same-root alias directories ("Ops" vs "ops")
      // are not enumerated. Only the configured "ops" store is returned; alias discovery and its
      // deterministic ordering no longer apply on the configured-agent path.
      expect(targets.map((target) => target.storePath).toSorted()).toEqual(
        [lowerStorePaths.ops!].toSorted(),
      );
      expect(targets.map((target) => target.storePath)).not.toContain(upperStorePaths.Ops);
    });
  });
});
