import type { Kind } from "./hash";

export interface IdHash {
  kind: Kind;
  hash: string;
}

export type BanReason = "manual" | "propagated";

export interface BannedRow {
  app: string;
  hash: string;
  kind: Kind;
  reason: BanReason;
  note: string | null;
  created_at: number;
}

export type BanListRow = Omit<BannedRow, "app">;

export interface CheckListRow {
  id: number;
  ref: string;
  blocked: number;
  matched: number;
  bit0: number | null;
  intent: string | null;
  created_at: number;
}

export interface AdminLogEntry {
  action: "ban" | "unban";
  kind: Kind | null;
  hash: string | null;
  ref: string | null;
  note: string | null;
}

export interface AdminLogRow extends AdminLogEntry {
  id: number;
  created_at: number;
}

/** Keyset position: the last row of the previous page (pages go newest first). */
export interface After {
  createdAt: number;
  key: string | number;
}

export interface CheckLogRow {
  ref: string;
  blocked: boolean;
  matched: boolean;
  bit0: boolean | null;
  intent: string | null;
}

export class Store {
  constructor(private readonly db: D1Database) {}

  async anyBanned(app: string, hashes: string[]): Promise<boolean> {
    // Stryker disable next-line ConditionalExpression: SQLite accepts `IN ()` and finds nothing; the guard only saves the query.
    if (hashes.length === 0) return false;
    const marks = hashes.map(() => "?").join(", ");
    const row = await this.db
      .prepare(`SELECT 1 FROM banned_ids WHERE app = ? AND hash IN (${marks}) LIMIT 1`)
      .bind(app, ...hashes)
      .first();
    return row !== null;
  }

  async pendingUnban(app: string, ref: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 FROM unban_refs WHERE app = ? AND ref = ? AND consumed_at IS NULL")
      .bind(app, ref)
      .first();
    return row !== null;
  }

  async consumeUnban(app: string, ref: string, now: number): Promise<void> {
    await this.db
      .prepare("UPDATE unban_refs SET consumed_at = ? WHERE app = ? AND ref = ? AND consumed_at IS NULL")
      .bind(now, app, ref)
      .run();
  }

  /** Inserts without overwriting existing rows (a manual mark does not become `propagated`). */
  async insertPropagated(app: string, ids: IdHash[], now: number): Promise<void> {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO banned_ids (app, hash, kind, reason, note, created_at)
       VALUES (?, ?, ?, 'propagated', NULL, ?) ON CONFLICT (app, hash) DO NOTHING`,
    );
    await this.db.batch(ids.map((id) => stmt.bind(app, id.hash, id.kind, now)));
  }

  /** Manual ban (overwrites a `propagated` mark) and its admin_log row, in one transaction. */
  async banManual(app: string, id: IdHash, note: string | null, now: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO banned_ids (app, hash, kind, reason, note, created_at)
           VALUES (?, ?, ?, 'manual', ?, ?)
           ON CONFLICT (app, hash) DO UPDATE SET kind = excluded.kind, reason = 'manual',
             note = excluded.note, created_at = excluded.created_at`,
        )
        .bind(app, id.hash, id.kind, note, now),
      this.adminLogInsert(app, { action: "ban", kind: id.kind, hash: id.hash, ref: null, note }, now),
    ]);
  }

  /**
   * Deletes the hash, schedules the unban by `ref` (either or both) and writes the admin_log row,
   * in one transaction. `true` if the hash was in the list.
   */
  async unban(app: string, id: IdHash | null, ref: string | null, now: number): Promise<boolean> {
    const statements: D1PreparedStatement[] = [];
    if (id) {
      statements.push(this.db.prepare("DELETE FROM banned_ids WHERE app = ? AND hash = ?").bind(app, id.hash));
    }
    if (ref) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO unban_refs (app, ref, created_at, consumed_at) VALUES (?, ?, ?, NULL)
             ON CONFLICT (app, ref) DO UPDATE SET created_at = excluded.created_at, consumed_at = NULL`,
          )
          .bind(app, ref, now),
      );
    }
    const entry = { action: "unban", kind: id?.kind ?? null, hash: id?.hash ?? null, ref, note: null } as const;
    statements.push(this.adminLogInsert(app, entry, now));
    const results = await this.db.batch(statements);
    return id !== null && results[0]!.meta.changes > 0;
  }

  private adminLogInsert(app: string, e: AdminLogEntry, now: number): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO admin_log (app, action, kind, hash, ref, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(app, e.action, e.kind, e.hash, e.ref, e.note, now);
  }

  async removeHashes(app: string, hashes: string[]): Promise<void> {
    // Stryker disable next-line ConditionalExpression: SQLite accepts `IN ()` and deletes nothing; the guard only saves the query.
    if (hashes.length === 0) return;
    const marks = hashes.map(() => "?").join(", ");
    await this.db
      .prepare(`DELETE FROM banned_ids WHERE app = ? AND hash IN (${marks})`)
      .bind(app, ...hashes)
      .run();
  }

  async getBanned(app: string, hash: string): Promise<BannedRow | null> {
    return this.db
      .prepare("SELECT * FROM banned_ids WHERE app = ? AND hash = ?")
      .bind(app, hash)
      .first<BannedRow>();
  }

  async getUnban(app: string, ref: string) {
    return this.db
      .prepare("SELECT created_at, consumed_at FROM unban_refs WHERE app = ? AND ref = ?")
      .bind(app, ref)
      .first<{ created_at: number; consumed_at: number | null }>();
  }

  async recentChecks(app: string, ref: string, limit = 20) {
    const { results } = await this.db
      .prepare(
        `SELECT blocked, matched, bit0, intent, created_at FROM check_log
         WHERE app = ? AND ref = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(app, ref, limit)
      .all<{ blocked: number; matched: number; bit0: number | null; intent: string | null; created_at: number }>();
    return results;
  }

  async logCheck(app: string, row: CheckLogRow, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO check_log (app, ref, blocked, matched, bit0, intent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        app,
        row.ref,
        row.blocked ? 1 : 0,
        row.matched ? 1 : 0,
        row.bit0 === null ? null : row.bit0 ? 1 : 0,
        row.intent,
        now,
      )
      .run();
  }

  async purgeCheckLog(olderThan: number): Promise<number> {
    const res = await this.db
      .prepare("DELETE FROM check_log WHERE created_at < ?")
      .bind(olderThan)
      .run();
    return res.meta.changes;
  }

  /** `GET /v1/admin/bans`: newest first, keyset on (created_at, hash). */
  async listBans(app: string, f: { kind?: Kind; reason?: BanReason }, after: After | null, limit: number) {
    return this.page<BanListRow>(
      "SELECT hash, kind, reason, note, created_at FROM banned_ids",
      "hash",
      app,
      [
        ["kind = ?", f.kind],
        ["reason = ?", f.reason],
      ],
      after,
      limit,
    );
  }

  /** `GET /v1/admin/checks`: newest first, keyset on (created_at, rowid); `id` is the rowid. */
  async listChecks(
    app: string,
    f: { ref?: string; blocked?: number; since?: number },
    after: After | null,
    limit: number,
  ) {
    return this.page<CheckListRow>(
      "SELECT rowid AS id, ref, blocked, matched, bit0, intent, created_at FROM check_log",
      "rowid",
      app,
      [
        ["ref = ?", f.ref],
        ["blocked = ?", f.blocked],
        ["created_at >= ?", f.since],
      ],
      after,
      limit,
    );
  }

  /** `GET /v1/admin/log`: newest first, keyset on (created_at, id). */
  async listAdminLog(app: string, after: After | null, limit: number) {
    return this.page<AdminLogRow>(
      "SELECT id, action, kind, hash, ref, note, created_at FROM admin_log",
      "id",
      app,
      [],
      after,
      limit,
    );
  }

  /**
   * One page of `select` for `app`, newest first: the filters whose value is not `undefined`,
   * then the rows strictly older than `after` in (created_at, key) order. The SQL fragments are
   * constants of this file, never request input; values always go as bound parameters.
   */
  private async page<T>(
    select: string,
    key: string,
    app: string,
    filters: [string, string | number | undefined][],
    after: After | null,
    limit: number,
  ): Promise<T[]> {
    const where = ["app = ?"];
    const values: (string | number)[] = [app];
    for (const [condition, value] of filters) {
      if (value === undefined) continue;
      where.push(condition);
      values.push(value);
    }
    if (after) {
      where.push(`(created_at, ${key}) < (?, ?)`);
      values.push(after.createdAt, after.key);
    }
    const { results } = await this.db
      .prepare(`${select} WHERE ${where.join(" AND ")} ORDER BY created_at DESC, ${key} DESC LIMIT ?`)
      .bind(...values, limit)
      .all<T>();
    return results;
  }
}
