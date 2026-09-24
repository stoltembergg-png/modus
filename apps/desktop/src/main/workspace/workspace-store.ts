import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { app } from "electron";
import type { WorkspaceInfo } from "../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../shared/contracts";
import { getDatabase } from "../db/database";

/** @deprecated Prefer importing CHATS_WORKSPACE_ID from contracts. */
export { CHATS_WORKSPACE_ID };

type WorkspaceRow = {
  id: string;
  root_path: string;
  display_name: string;
  is_git_repository: number;
  last_opened_at: string;
  pinned: number;
};

const SELECT_COLUMNS = "id, root_path, display_name, is_git_repository, last_opened_at, pinned";

function toWorkspace(row: WorkspaceRow): WorkspaceInfo {
  const inbox = row.id === CHATS_WORKSPACE_ID;
  return {
    id: row.id,
    rootPath: row.root_path,
    displayName: row.display_name,
    isGitRepository: row.is_git_repository === 1,
    lastOpenedAt: row.last_opened_at,
    pinned: row.pinned === 1,
    ...(inbox ? { inbox: true } : {}),
  };
}

/** Pinned projects first (most-recently-pinned on top), then recents. */
export function listWorkspaces(): WorkspaceInfo[] {
  const rows = getDatabase()
    .prepare(
      `select ${SELECT_COLUMNS}
       from workspaces
       order by pinned desc, coalesce(pinned_at, last_opened_at) desc`,
    )
    .all() as WorkspaceRow[];

  return rows.map(toWorkspace);
}

/** Project folders only — excludes the folderless Chats inbox. */
export function listProjectWorkspaces(): WorkspaceInfo[] {
  return listWorkspaces().filter((workspace) => !workspace.inbox);
}

export function getWorkspace(id: string): WorkspaceInfo | undefined {
  const row = getDatabase()
    .prepare(`select ${SELECT_COLUMNS} from workspaces where id = ?`)
    .get(id) as WorkspaceRow | undefined;
  return row ? toWorkspace(row) : undefined;
}

/** Ensure the inbox workspace exists for chats started without a folder. */
export function ensureChatsWorkspace(): WorkspaceInfo {
  const existing = getWorkspace(CHATS_WORKSPACE_ID);
  if (existing) {
    return existing;
  }
  const rootPath = join(app.getPath("userData"), "inbox-chats");
  mkdirSync(rootPath, { recursive: true });
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values (?, ?, ?, 0, ?, ?)
       on conflict(id) do update set last_opened_at = excluded.last_opened_at`,
    )
    .run(CHATS_WORKSPACE_ID, rootPath, "Chats", now, now);
  return {
    id: CHATS_WORKSPACE_ID,
    rootPath,
    displayName: "Chats",
    isGitRepository: false,
    lastOpenedAt: now,
    pinned: false,
    inbox: true,
  };
}

export function upsertWorkspace(rootPath: string, isGitRepository: boolean): WorkspaceInfo {
  const db = getDatabase();
  const existing = db
    .prepare(`select ${SELECT_COLUMNS} from workspaces where root_path = ?`)
    .get(rootPath) as WorkspaceRow | undefined;

  const now = new Date().toISOString();
  const id = existing?.id ?? randomUUID();
  // Preserve a user-renamed display name across re-opens; only seed it on first add.
  const displayName = existing?.display_name ?? basename(rootPath);

  db.prepare(
    `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict(root_path) do update set
       is_git_repository = excluded.is_git_repository,
       last_opened_at = excluded.last_opened_at`,
  ).run(id, rootPath, displayName, isGitRepository ? 1 : 0, now, now);

  return {
    id,
    rootPath,
    displayName,
    isGitRepository,
    lastOpenedAt: now,
    pinned: existing?.pinned === 1,
  };
}

/** Toggle a project's pinned state; `pinned_at` orders pinned projects. */
export function setWorkspacePinned(id: string, pinned: boolean): void {
  getDatabase()
    .prepare("update workspaces set pinned = ?, pinned_at = ? where id = ?")
    .run(pinned ? 1 : 0, pinned ? new Date().toISOString() : null, id);
}

/** Rename a project's sidebar display name. Empty names are rejected by the IPC schema. */
export function renameWorkspace(id: string, displayName: string): void {
  getDatabase().prepare("update workspaces set display_name = ? where id = ?").run(displayName, id);
}

/**
 * Remove a project from Modus. Sessions/events/runs cascade via FK, but their
 * runtime + checkpoint teardown must happen first (see archiveWorkspaceSessions).
 * Files on disk are never touched.
 */
export function removeWorkspace(id: string): void {
  if (id === CHATS_WORKSPACE_ID) {
    throw new Error("The Chats inbox cannot be removed.");
  }
  getDatabase().prepare("delete from workspaces where id = ?").run(id);
}
