import { expect, it, vi, type Mock } from "vitest";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";

type OutputFixture = { dir: string; outputBase: string; outputPath: string };

export function registerVideoOutputCapabilityCliTests({
  mocks,
  generateVideo,
  primeGeneratedVideoUrl,
  mockVideoFetch,
  outputFixture,
  expectOutputFile,
  expectRuntimeErrorContains,
}: {
  mocks: {
    generateVideo: Mock;
    runtime: { writeJson: Mock; error: Mock; exit: Mock };
  };
  generateVideo: (...args: string[]) => Promise<void>;
  primeGeneratedVideoUrl: (url: string) => void;
  mockVideoFetch: (body: ConstructorParameters<typeof Response>[0]) => Mock;
  outputFixture: (extension: string, original: string) => Promise<OutputFixture>;
  expectOutputFile: (fixture: OutputFixture, contents: string) => Promise<void>;
  expectRuntimeErrorContains: (expected: string) => void;
}): void {
  it("preserves an existing --output and removes its temp when a video stream fails", async () => {
    primeGeneratedVideoUrl("https://example.com/broken-video.mp4");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial-video"));
        controller.error(new Error("video stream exploded"));
      },
    });
    mockVideoFetch(stream);
    const fixture = await outputFixture(".mp4", "keep-existing-video");
    const { outputBase } = fixture;
    await expect(generateVideo("--output", outputBase)).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("video stream exploded");
    await expectOutputFile(fixture, "keep-existing-video");
  });

  it("publishes nothing when a generated video download is interrupted", async () => {
    const scope = new AsyncWorkScope();
    primeGeneratedVideoUrl("https://example.com/generated-video.mp4");
    const downloadStarted = createDeferredCore();
    const release = createDeferredCore();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("partial-video"));
        await release.promise;
        try {
          controller.enqueue(new TextEncoder().encode("-bytes"));
          controller.close();
        } catch {
          // The interrupted download cancelled this body before the rest arrived.
        }
      },
    });
    const downloadSignal = createDeferredCore<AbortSignal | undefined>();
    const fetchMock = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      downloadSignal.resolve(init?.signal);
      downloadStarted.resolve();
      return new Response(stream, { headers: { "content-type": "video/mp4" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const fixture = await outputFixture(".mp4", "keep-existing-video");
    const running = scope.track(() => generateVideo("--output", fixture.outputBase));
    await downloadStarted.promise;

    const stopReason = new DOMException("CLI stopping (SIGINT)", "AbortError");
    scope.beginClose(stopReason);
    release.resolve();
    await running;

    await expectOutputFile(fixture, "keep-existing-video");
    // The buffered read has no signal of its own, so the request must carry ours.
    expect((await downloadSignal.promise)?.reason).toBe(stopReason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
    expect(mocks.runtime.error).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
  });

  it("does not start a generated video download after an accepted interrupt", async () => {
    const scope = new AsyncWorkScope();
    const fetchMock = mockVideoFetch(Buffer.from("video-bytes"));
    mocks.generateVideo.mockImplementationOnce(async () => {
      scope.beginClose(new DOMException("CLI stopping (SIGINT)", "AbortError"));
      return {
        provider: "vydra",
        model: "veo3",
        attempts: [],
        videos: [
          {
            url: "https://example.com/late-video.mp4",
            mimeType: "video/mp4",
            fileName: "late.mp4",
          },
        ],
      };
    });
    const fixture = await outputFixture(".mp4", "keep-existing-video");

    await scope.track(() => generateVideo("--output", fixture.outputBase));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
    expect(mocks.runtime.error).not.toHaveBeenCalled();
    await expectOutputFile(fixture, "keep-existing-video");
  });
}
