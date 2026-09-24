import { describe, expect, it } from "vitest";
import { beginResizeGesture, endResizeGesture } from "./resizeGesture";

function makeHost() {
  return { style: { cursor: "auto", userSelect: "auto" } };
}

function makeHandle() {
  return { dataset: {} as DOMStringMap };
}

describe("resize gesture chrome", () => {
  it("locks the cursor + selection and flags the handle while dragging", () => {
    const host = makeHost();
    const handle = makeHandle();

    beginResizeGesture(host, handle);

    expect(host.style.cursor).toBe("col-resize");
    expect(host.style.userSelect).toBe("none");
    expect(handle.dataset.resizing).toBe("");
  });

  it("restores the cursor + selection and clears the flag on release", () => {
    const host = makeHost();
    const handle = makeHandle();

    beginResizeGesture(host, handle);
    endResizeGesture(host, handle);

    expect(host.style.cursor).toBe("");
    expect(host.style.userSelect).toBe("");
    expect("resizing" in handle.dataset).toBe(false);
  });

  it("still restores the body chrome when the handle is gone (unmount mid-drag)", () => {
    const host = makeHost();

    beginResizeGesture(host, makeHandle());
    endResizeGesture(host, null);

    expect(host.style.cursor).toBe("");
    expect(host.style.userSelect).toBe("");
  });

  it("is idempotent when released twice", () => {
    const host = makeHost();
    const handle = makeHandle();

    beginResizeGesture(host, handle);
    endResizeGesture(host, handle);
    endResizeGesture(host, null);

    expect(host.style.cursor).toBe("");
    expect(host.style.userSelect).toBe("");
    expect("resizing" in handle.dataset).toBe(false);
  });
});
