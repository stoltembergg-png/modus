import type { ProviderLimitsState } from "../../shared/contracts";
import { IPC_CHANNELS } from "./channels";
import { limitsCodexEnabledSchema, limitsNoInputSchema, parseIpcInput } from "./schemas";
import type { TrustedSenderEvent } from "./trusted-sender";

type ProviderLimitsService = {
  getProviderLimits(): Promise<ProviderLimitsState>;
  refreshProviderLimits(): Promise<ProviderLimitsState>;
  setCodexLimitsEnabled(enabled: boolean): Promise<ProviderLimitsState>;
};

type HandlerRegistration = {
  handle(channel: string, listener: (event: TrustedSenderEvent, input?: unknown) => unknown): void;
};

export function registerProviderLimitsIpcHandlers(
  ipcMain: HandlerRegistration,
  assertTrustedSender: (event: TrustedSenderEvent) => void,
  service: ProviderLimitsService,
): void {
  ipcMain.handle(IPC_CHANNELS.modelLimits, (event, input) => {
    assertTrustedSender(event);
    parseIpcInput(limitsNoInputSchema, input, IPC_CHANNELS.modelLimits);
    return service.getProviderLimits();
  });
  ipcMain.handle(IPC_CHANNELS.modelLimitsRefresh, (event, input) => {
    assertTrustedSender(event);
    parseIpcInput(limitsNoInputSchema, input, IPC_CHANNELS.modelLimitsRefresh);
    return service.refreshProviderLimits();
  });
  ipcMain.handle(IPC_CHANNELS.modelLimitsSetCodexEnabled, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(
      limitsCodexEnabledSchema,
      input,
      IPC_CHANNELS.modelLimitsSetCodexEnabled,
    );
    return service.setCodexLimitsEnabled(parsed.enabled);
  });
}
