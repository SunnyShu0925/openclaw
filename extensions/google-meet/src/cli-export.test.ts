import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeMeetExportBundle } from "./cli-export.js";
import type { GoogleMeetArtifactsResult, GoogleMeetAttendanceResult } from "./meet-api.js";

const emptyArtifacts: GoogleMeetArtifactsResult = {
  conferenceRecords: [],
  artifacts: [],
};

const emptyAttendance: GoogleMeetAttendanceResult = {
  conferenceRecords: [],
  attendance: [],
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("google-meet export output directory", () => {
  it("preserves a trailing-space literal output directory on disk", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "meet-export-"));
    tempDirs.push(base);
    const trailingDir = path.join(base, "custom output ");
    const payload = await writeMeetExportBundle({
      outputDir: trailingDir,
      artifacts: emptyArtifacts,
      attendance: emptyAttendance,
    });

    // The caller-visible outputDir must keep the exact literal spelling.
    expect(payload.outputDir).toBe(trailingDir);
    // Files must be written under the untrimmed directory name on disk.
    expect(payload.files[0]).toBe(path.join(trailingDir, "summary.md"));
    const written = await readdir(trailingDir);
    expect(written).toEqual(
      expect.arrayContaining([
        "summary.md",
        "attendance.csv",
        "transcript.md",
        "artifacts.json",
        "attendance.json",
        "manifest.json",
      ]),
    );
    // The trimmed spelling must NOT be where files landed.
    await expect(readdir(path.join(base, "custom output"))).rejects.toThrow();
  });
});
