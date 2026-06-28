import { describe, expect, it } from "vitest";
import { renderGuestStudioPage } from "./helpers/studio-page";

describe("StudioPage participant role labels", () => {
  it("does not label the local participant as host when a guest joins", async () => {
    const studio = renderGuestStudioPage({ name: "Guest Alice" });

    await studio.join();

    expect(studio.screen.getByText("Guest Alice")).toBeTruthy();
    expect(studio.screen.queryByText("host")).toBeNull();
  });
});
