import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeExternalFileWithinOutputRoot } from "./output-files.js";

describe("writeExternalFileWithinOutputRoot", () => {
  it.skipIf(process.platform === "win32")(
    "preserves surrounding whitespace in the output path",
    async () => {
      const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-output-trim-"));
      const neighborPath = path.join(outputRoot, "report.pdf");
      const outputPath = path.join(outputRoot, " report.pdf ");
      try {
        const result = await writeExternalFileWithinOutputRoot({
          rootDir: outputRoot,
          path: outputPath,
          write: async (tempPath) => {
            await fs.writeFile(tempPath, "file content", "utf8");
          },
        });

        expect(result).toBe(outputPath);
        await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("file content");
        await expect(fs.access(neighborPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await fs.rm(outputRoot, { recursive: true, force: true });
      }
    },
  );

  it("rejects a whitespace-only output path", async () => {
    await expect(
      writeExternalFileWithinOutputRoot({
        path: "   ",
        write: async () => {},
      }),
    ).rejects.toThrow("output path is required");
  });
});
