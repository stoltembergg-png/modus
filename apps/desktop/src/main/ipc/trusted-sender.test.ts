import { afterEach, describe, expect, it } from "vitest";
import { assertTrustedSender, registerTrustedSender } from "./trusted-sender";

describe("trusted main renderer sender", () => {
  const registrations: Array<() => void> = [];
  afterEach(() => {
    for (const unregister of registrations.splice(0)) unregister();
  });

  function register(rendererUrl: string) {
    const mainFrame = { url: rendererUrl };
    const contents = { mainFrame };
    registrations.push(registerTrustedSender(contents, rendererUrl));
    return { contents, mainFrame };
  }

  it("accepts only the registered main renderer at its configured development origin", () => {
    const { contents, mainFrame } = register("http://localhost:5173/");
    expect(() => assertTrustedSender({ sender: contents, senderFrame: mainFrame })).not.toThrow();
  });

  it("rejects an arbitrary file URL", () => {
    const { contents } = register("file:///app/renderer/index.html");
    expect(() =>
      assertTrustedSender({ sender: contents, senderFrame: { url: "file:///tmp/attacker.html" } }),
    ).toThrow("Blocked IPC call from untrusted renderer frame.");
  });

  it("rejects a loopback URL with the wrong port or origin", () => {
    const { contents } = register("http://localhost:5173/");
    expect(() =>
      assertTrustedSender({ sender: contents, senderFrame: { url: "http://localhost:5174/" } }),
    ).toThrow("Blocked IPC call from untrusted renderer frame.");
    expect(() =>
      assertTrustedSender({ sender: contents, senderFrame: { url: "http://127.0.0.1:5173/" } }),
    ).toThrow("Blocked IPC call from untrusted renderer frame.");
  });

  it("rejects a subframe even when it has the trusted origin", () => {
    const { contents } = register("http://localhost:5173/");
    expect(() =>
      assertTrustedSender({
        sender: contents,
        senderFrame: { url: "http://localhost:5173/child" },
      }),
    ).toThrow("Blocked IPC call from untrusted renderer frame.");
  });

  it("rejects a different WebContents at the trusted URL", () => {
    const { mainFrame } = register("http://localhost:5173/");
    expect(() => assertTrustedSender({ sender: { mainFrame }, senderFrame: mainFrame })).toThrow(
      "Blocked IPC call from untrusted renderer frame.",
    );
  });

  it("accepts only the registered packaged renderer file URL", () => {
    const { contents, mainFrame } = register("file:///app/resources/renderer/index.html");
    expect(() => assertTrustedSender({ sender: contents, senderFrame: mainFrame })).not.toThrow();
    expect(() =>
      assertTrustedSender({
        sender: contents,
        senderFrame: { url: "file:///app/resources/renderer/other.html" },
      }),
    ).toThrow("Blocked IPC call from untrusted renderer frame.");
  });
});
