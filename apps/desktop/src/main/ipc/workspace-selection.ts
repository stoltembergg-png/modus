const selections = new Map<object, string>();

export function setSelectedWorkspace(sender: object, workspaceId: string | undefined): void {
  if (workspaceId) {
    selections.set(sender, workspaceId);
  } else {
    selections.delete(sender);
  }
}

export function getSelectedWorkspace(sender: object): string | undefined {
  return selections.get(sender);
}

export function clearSelectedWorkspace(workspaceId: string): void {
  for (const [sender, selectedWorkspaceId] of selections) {
    if (selectedWorkspaceId === workspaceId) selections.delete(sender);
  }
}

export function clearSenderWorkspaceSelection(sender: object): void {
  selections.delete(sender);
}
