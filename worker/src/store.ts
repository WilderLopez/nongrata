import type { Kind } from "./hash";

export interface IdHash {
  kind: Kind;
  hash: string;
}

export interface BannedRow {
  app: string;
  hash: string;
  kind: Kind;
  reason: "manual" | "propagated";
  note: string | null;
  created_at: number;
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
    // Stryker disable next-line ConditionalExpression: SQLite acepta `IN ()` y no encuentra nada; la guarda solo ahorra la consulta.
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

  async scheduleUnban(app: string, ref: string, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO unban_refs (app, ref, created_at, consumed_at) VALUES (?, ?, ?, NULL)
         ON CONFLICT (app, ref) DO UPDATE SET created_at = excluded.created_at, consumed_at = NULL`,
      )
      .bind(app, ref, now)
      .run();
  }

  /** Inserta sin pisar las filas existentes (una marca manual no pasa a `propagated`). */
  async insertPropagated(app: string, ids: IdHash[], now: number): Promise<void> {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO banned_ids (app, hash, kind, reason, note, created_at)
       VALUES (?, ?, ?, 'propagated', NULL, ?) ON CONFLICT (app, hash) DO NOTHING`,
    );
    await this.db.batch(ids.map((id) => stmt.bind(app, id.hash, id.kind, now)));
  }

  async banManual(app: string, id: IdHash, note: string | null, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO banned_ids (app, hash, kind, reason, note, created_at)
         VALUES (?, ?, ?, 'manual', ?, ?)
         ON CONFLICT (app, hash) DO UPDATE SET kind = excluded.kind, reason = 'manual',
           note = excluded.note, created_at = excluded.created_at`,
      )
      .bind(app, id.hash, id.kind, note, now)
      .run();
  }

  async removeHashes(app: string, hashes: string[]): Promise<void> {
    // Stryker disable next-line ConditionalExpression: SQLite acepta `IN ()` y no borra nada; la guarda solo ahorra la consulta.
    if (hashes.length === 0) return;
    const marks = hashes.map(() => "?").join(", ");
    await this.db
      .prepare(`DELETE FROM banned_ids WHERE app = ? AND hash IN (${marks})`)
      .bind(app, ...hashes)
      .run();
  }

  async unbanHash(app: string, hash: string): Promise<boolean> {
    const res = await this.db
      .prepare("DELETE FROM banned_ids WHERE app = ? AND hash = ?")
      .bind(app, hash)
      .run();
    return res.meta.changes > 0;
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
}
