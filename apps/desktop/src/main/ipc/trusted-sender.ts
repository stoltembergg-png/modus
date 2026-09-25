type TrustedFrame = { url: string };
type TrustedWebContents = { mainFrame: TrustedFrame };

export type TrustedSenderEvent = {
  sender?: TrustedWebContents;
  senderFrame?: TrustedFrame | null;
};

type TrustedRenderer = { kind: "file"; url: string } | { kind: "origin"; origin: string };

const trustedSenders = new WeakMap<
  TrustedWebContents,
  { mainFrame: TrustedFrame; renderer: TrustedRenderer }
>();

function rendererFor(rendererUrl: string): TrustedRenderer {
  const url = new URL(rendererUrl);
  if (url.protocol === "file:") {
    url.hash = "";
    return { kind: "file", url: url.href };
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    return { kind: "origin", origin: url.origin };
  }
  throw new Error(`Unsupported main renderer URL protocol: ${url.protocol}`);
}

export function isTrustedRendererUrl(rendererUrl: string, rawUrl: string): boolean {
  try {
    const renderer = rendererFor(rendererUrl);
    const url = new URL(rawUrl);
    if (renderer.kind === "file") {
      url.hash = "";
      return url.href === renderer.url;
    }
    return url.origin === renderer.origin;
  } catch {
    return false;
  }
}

export function registerTrustedSender(
  webContents: TrustedWebContents,
  rendererUrl: string,
): () => void {
  const registration = { mainFrame: webContents.mainFrame, renderer: rendererFor(rendererUrl) };
  trustedSenders.set(webContents, registration);
  return () => {
    if (trustedSenders.get(webContents) === registration) trustedSenders.delete(webContents);
  };
}

export function assertTrustedSender(event: TrustedSenderEvent): void {
  const registration = event.sender && trustedSenders.get(event.sender);
  if (
    registration &&
    event.senderFrame === registration.mainFrame &&
    event.senderFrame &&
    isTrustedRendererUrl(
      registration.renderer.kind === "file"
        ? registration.renderer.url
        : registration.renderer.origin,
      event.senderFrame.url,
    )
  ) {
    return;
  }
  throw new Error("Blocked IPC call from untrusted renderer frame.");
}
