import { Menu } from "@base-ui/react/menu";
import { IconCheck, IconGitBranch } from "@tabler/icons-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { GitBranchSummary } from "../../../../shared/contracts";
import { BranchedMenu, type BranchedMenuItem } from "../../components/ui/BranchedMenu";
import { ShinyText } from "../../components/ui/ShinyText";

type BranchSwitcherProps = {
  /** Repo working dir whose branches are listed / checked out. Undefined → disabled. */
  cwd: string | undefined;
  /** Trigger inner content (icon + label + chevron). The host styles its own surface. */
  children: ReactNode;
  /** Tailwind classes for the trigger button so each surface keeps its own look. */
  triggerClassName: string;
  align?: "start" | "end";
  /** Force-disable independent of cwd (e.g. while a parent action is busy). */
  disabled?: boolean;
  /** Surface a failed checkout (uncommitted changes, etc.) to the host UI. */
  onError?: (message: string) => void;
  /** Fired after a successful checkout so the host can refresh derived views. */
  onAfterSwitch?: () => void;
  /** Fired when Git says this branch is already checked out in a linked worktree. */
  onWorktreeBranch?: (path: string, branch: string) => void;
};

/**
 * Local-branch viewer + switcher shared by the Changes panel and the workspace
 * top bar. Uses a React Bits BranchedMenu tree so local / remote / worktree
 * refs read as one animated hierarchy.
 */
export function BranchSwitcher({
  cwd,
  children,
  triggerClassName,
  align = "start",
  disabled = false,
  onError,
  onAfterSwitch,
  onWorktreeBranch,
}: BranchSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [branchState, setBranchState] = useState<
    { cwd: string; summary: GitBranchSummary } | undefined
  >();
  const [busy, setBusy] = useState<string | undefined>();
  const branches = branchState && branchState.cwd === cwd ? branchState.summary : undefined;

  const refreshBranches = useCallback(
    async (targetCwd: string, active: () => boolean = () => true) => {
      try {
        const summary = await window.modus.git.branches(targetCwd);
        if (active()) setBranchState({ cwd: targetCwd, summary });
      } catch {
        if (active()) setBranchState({ cwd: targetCwd, summary: { local: [], remote: [] } });
      }
    },
    [],
  );

  useEffect(() => {
    if (!open || !cwd) {
      return;
    }
    let active = true;
    void refreshBranches(cwd, () => active);
    return () => {
      active = false;
    };
  }, [open, cwd, refreshBranches]);

  const switchTo = useCallback(
    async (name: string): Promise<void> => {
      if (!cwd) {
        return;
      }
      setBusy(name);
      try {
        const result = await window.modus.git.checkout({ cwd, name });
        if (result.kind === "worktree" && result.worktreePath) {
          onWorktreeBranch?.(result.worktreePath, result.branch ?? name);
          return;
        }
        onAfterSwitch?.();
        setOpen(false);
      } catch (cause) {
        onError?.(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(undefined);
      }
    },
    [cwd, onAfterSwitch, onError, onWorktreeBranch],
  );

  const locals = branches?.local ?? [];
  const remotes = branches?.remote ?? [];
  const current = locals.find((branch) => branch.current)?.name ?? branches?.current;

  const menuItems = useMemo((): BranchedMenuItem[] => {
    const localChildren = locals.map((branch) => {
      const meta = branch.worktreePath ? "worktree" : branch.current ? "current" : undefined;
      return {
        value: `local:${branch.name}`,
        label: busy === branch.name ? `${branch.name}…` : branch.name,
        icon: branch.current ? <IconCheck size={13} stroke={2} /> : <IconGitBranch size={13} stroke={1.7} />,
        ...(meta ? { meta } : {}),
      };
    });
    const remoteChildren = remotes.map((branch) => ({
      value: `remote:${branch.name}`,
      label: branch.name,
      icon: <IconGitBranch size={13} stroke={1.7} />,
      meta: "remote",
    }));
    const items: BranchedMenuItem[] = [
      {
        label: "Local",
        children: localChildren.length > 0 ? localChildren : [{ value: "local:none", label: "No local branches" }],
      },
    ];
    if (remoteChildren.length > 0) {
      items.push({ label: "Remote", children: remoteChildren });
    }
    const worktreeChildren = locals
      .filter((branch) => Boolean(branch.worktreePath))
      .map((branch) => ({
        value: `worktree:${branch.name}`,
        label: branch.name,
        icon: <IconGitBranch size={13} stroke={1.7} />,
        meta: "linked",
      }));
    if (worktreeChildren.length > 0) {
      items.push({ label: "Worktrees", children: worktreeChildren });
    }
    return items;
  }, [locals, remotes, busy]);

  return (
    <Menu.Root onOpenChange={setOpen} open={open}>
      <Menu.Trigger className={triggerClassName} disabled={disabled || !cwd}>
        {children}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align={align} side="bottom" sideOffset={6}>
          <Menu.Popup className="origin-(--transform-origin) min-w-[260px] popup-chrome p-2">
            {!branches ? (
              <div className="px-2.5 py-3 text-center text-2xs text-fg-faint">
                <ShinyText>Loading…</ShinyText>
              </div>
            ) : locals.length === 0 && remotes.length === 0 ? (
              <div className="px-2.5 py-3 text-center text-2xs text-fg-faint">No branches</div>
            ) : (
              <BranchedMenu
                defaultActive={current ? `local:${current}` : ""}
                defaultOpen={[0]}
                fontSize={12}
                items={menuItems}
                onSelect={(value) => {
                  if (value.endsWith(":none")) return;
                  const name = value.replace(/^(local|remote|worktree):/, "");
                  if (!name || name === current) return;
                  void switchTo(name);
                }}
                rowHeight={28}
                width={248}
              />
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
