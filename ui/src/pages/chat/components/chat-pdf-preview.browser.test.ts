import { expect, it, vi } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/side-panel.css";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import "./chat-detail-panel.tsx";

const browserMode = "__vitest_browser__" in globalThis;

type DetailPanel = HTMLElement & {
  content: SidebarContent;
  updateComplete: Promise<unknown>;
};

it.skipIf(!browserMode)(
  "fills the sidebar content with a native PDF reader that keeps the source URL",
  async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("%PDF-1.7\n")));
    const container = document.createElement("div");
    container.className = "side-panel__panel";
    container.style.cssText = "display:flex;width:480px;height:640px;";
    const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
    panel.className = "chat-sidebar";
    panel.content = {
      kind: "attachment",
      attachmentKind: "document",
      title: "brief.pdf",
      src: "/__openclaw__/assistant-media?mediaTicket=pdf-preview",
      mimeType: "application/pdf",
      sizeBytes: 8_231,
    };
    container.append(panel);
    document.body.append(container);

    try {
      await panel.updateComplete;
      await expect.poll(() => panel.querySelector("iframe")).not.toBeNull();
      const frame = panel.querySelector<HTMLIFrameElement>("iframe")!;
      const surface = panel.querySelector<HTMLElement>(".sidebar-pdf-preview__surface")!;
      // Same-origin srcs load directly so the browser's native viewer can keep the
      // Content-Disposition filename; the frame must not point at an anonymous Blob URL.
      expect(frame.getAttribute("src")).toBe(
        "/__openclaw__/assistant-media?mediaTicket=pdf-preview",
      );
      expect(getComputedStyle(frame).display).toBe("block");
      const content = panel.querySelector<HTMLElement>(".sidebar-content")!;
      const contentBox = content.getBoundingClientRect();
      expect(contentBox.height).toBeGreaterThan(0);
      for (const element of [surface, frame]) {
        const box = element.getBoundingClientRect();
        for (const edge of ["top", "right", "bottom", "left"] as const) {
          expect(box[edge]).toBeCloseTo(contentBox[edge], 0);
        }
      }
      expect(panel.querySelector(".sidebar-file-toolbar")).toBeNull();
      expect(panel.querySelector("object")).toBeNull();
    } finally {
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);
