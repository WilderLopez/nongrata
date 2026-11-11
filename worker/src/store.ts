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

/** Who acted: the Worker's `ADMIN_TOKEN`, or a paired device (docs/DEVICE-PAIRING.md). */
export type Actor = "token" | `device:${string}`;

export interface AdminLogEntry {
  action: "ban" | "unban" | "pair" | "revoke";
  kind: Kind | null;
  hash: string | null;
  ref: string | null;
  note: string | null;
  /** The device that `pair` and `revoke` are about; `null` for `ban` and `unban`. */
  device_id: string | null;
  /** `null` only in rows written before migration 0003. */
  actor: Actor | null;
}

export interface AdminLogRow extends AdminLogEntry {
  id: number;
  created_at: number;
}

export type Role = "read" | "admin";
export type Platform = "ios" | "ipados" | "macos" | "other";

export interface DeviceRow {
  id: string;
  name: string;
  platform: Platform;
  role: Role;
  public_key: string;
  status: "pending" | "active";
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

/** A device and the expiry of the pairing it claimed (`null` once that pairing is gone). */
export interface DeviceWithPairing extends DeviceRow {
  pairing_expires_at: number | null;
}

export interface PairingRow {
  id: string;
  secret_hash: string;
  role: Role;
  label: string | null;
  created_at: number;
  expires_at: number;
  failed_attempts: number;
  claimed_at: number | null;
  device_id: string | null;
  approved_at: number | null;
}

/** A pairing and the device that claimed it, while that device exists. */
export interface PairingWithDevice extends PairingRow {
  device: Pick<DeviceRow, "name" | "platform" | "public_key"> | null;
}

export interface NewDevice {
  id: string;
  name: string;
  platform: Platform;
  publicKey: string;
}

const DEVICE_COLUMNS = "id, name, platform, role, public_key, status, created_at, last_used_at, revoked_at";

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

  /** When the pending unban of `ref` was scheduled, or `null` if there is none. */
  async pendingUnban(app: string, ref: string): Promise<number | null> {
    const row = await this.db
      .prepare("SELECT created_at FROM unban_refs WHERE app = ? AND ref = ? AND consumed_at IS NULL")
      .bind(app, ref)
      .first<{ created_at: number }>();
    return row?.created_at ?? null;
  }

  async consumeUnban(app: string, ref: string, now: number): Promise<void> {
    await this.db
      .prepare("UPDATE unban_refs SET consumed_at = ? WHERE app = ? AND ref = ? AND consumed_at IS NULL")
      .bind(now, app, ref)
      .run();
  }

  /**
   * Inserts without overwriting existing rows (a manual mark does not become `propagated`), with
   * the `ref` of the device that carried them so an unban by that ref can remove them at once.
   */
  async insertPropagated(app: string, ref: string, ids: IdHash[], now: number): Promise<void> {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO banned_ids (app, hash, kind, reason, note, created_at, ref)
       VALUES (?, ?, ?, 'propagated', NULL, ?, ?) ON CONFLICT (app, hash) DO NOTHING`,
    );
    await this.db.batch(ids.map((id) => stmt.bind(app, id.hash, id.kind, now, ref)));
  }

  /** Manual ban (overwrites a `propagated` mark) and its admin_log row, in one transaction. */
  async banManual(app: string, id: IdHash, note: string | null, actor: Actor, now: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO banned_ids (app, hash, kind, reason, note, created_at)
           VALUES (?, ?, ?, 'manual', ?, ?)
           ON CONFLICT (app, hash) DO UPDATE SET kind = excluded.kind, reason = 'manual',
             note = excluded.note, created_at = excluded.created_at, ref = NULL`,
        )
        .bind(app, id.hash, id.kind, note, now),
      this.adminLogInsert(app, { action: "ban", kind: id.kind, hash: id.hash, ref: null, note, device_id: null, actor }, now),
    ]);
  }

  /**
   * Deletes the hash, schedules the unban by `ref` (either or both) and writes the admin_log row,
   * in one transaction. An unban by `ref` also removes the automatic bans that device
   * propagated. `true` if the hash was in the list.
   */
  async unban(app: string, id: IdHash | null, ref: string | null, actor: Actor, now: number): Promise<boolean> {
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
        this.db.prepare("DELETE FROM banned_ids WHERE app = ? AND ref = ? AND reason = 'propagated'").bind(app, ref),
      );
    }
    const entry = {
      action: "unban",
      kind: id?.kind ?? null,
      hash: id?.hash ?? null,
      ref,
      note: null,
      device_id: null,
      actor,
    } as const;
    statements.push(this.adminLogInsert(app, entry, now));
    const results = await this.db.batch(statements);
    return id !== null && results[0]!.meta.changes > 0;
  }

  /** `app` is `null` for the actions that concern the whole Worker (`pair`, `revoke`). */
  private adminLogInsert(app: string | null, e: AdminLogEntry, now: number): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO admin_log (app, action, kind, hash, ref, note, device_id, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(app, e.action, e.kind, e.hash, e.ref, e.note, e.device_id, e.actor, now);
  }

  /**
   * Removes the hashes of a device whose unban by ref was scheduled at `scheduledAt`, except the
   * manual bans made after it: those are newer decisions and win.
   */
  async removeHashes(app: string, hashes: string[], scheduledAt: number): Promise<void> {
    // Stryker disable next-line ConditionalExpression: SQLite accepts `IN ()` and deletes nothing; the guard only saves the query.
    if (hashes.length === 0) return;
    const marks = hashes.map(() => "?").join(", ");
    await this.db
      .prepare(
        `DELETE FROM banned_ids WHERE app = ? AND hash IN (${marks})
         AND (reason = 'propagated' OR created_at <= ?)`,
      )
      .bind(app, ...hashes, scheduledAt)
      .run();
  }

  async getBanned(app: string, hash: string): Promise<BannedRow | null> {
    return this.db
      .prepare("SELECT app, hash, kind, reason, note, created_at FROM banned_ids WHERE app = ? AND hash = ?")
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
      [
        ["app = ?", app],
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
      [
        ["app = ?", app],
        ["ref = ?", f.ref],
        ["blocked = ?", f.blocked],
        ["created_at >= ?", f.since],
      ],
      after,
      limit,
    );
  }

  /**
   * `GET /v1/admin/log`: the app's rows (`ban`, `unban`) or, with `app` null, the Worker's
   * (`pair`, `revoke`, stored with a NULL app); newest first, keyset on (created_at, id).
   */
  async listAdminLog(app: string | null, after: After | null, limit: number) {
    return this.page<AdminLogRow>(
      "SELECT id, action, kind, hash, ref, note, device_id, actor, created_at FROM admin_log",
      "id",
      [app === null ? ["app IS NULL", null] : ["app = ?", app]],
      after,
      limit,
    );
  }

  // Admin devices and pairings (docs/DEVICE-PAIRING.md).

  async createPairing(p: Pick<PairingRow, "id" | "secret_hash" | "role" | "label" | "created_at" | "expires_at">) {
    await this.db
      .prepare(
        `INSERT INTO admin_pairings (id, secret_hash, role, label, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(p.id, p.secret_hash, p.role, p.label, p.created_at, p.expires_at)
      .run();
  }

  async getPairing(id: string): Promise<PairingWithDevice | null> {
    const row = await this.db
      .prepare(
        `SELECT p.*, d.name AS device_name, d.platform AS device_platform, d.public_key AS device_public_key
         FROM admin_pairings p LEFT JOIN admin_devices d ON d.id = p.device_id WHERE p.id = ?`,
      )
      .bind(id)
      .first<PairingRow & { device_name: string | null; device_platform: Platform; device_public_key: string }>();
    if (!row) return null;
    const { device_name: name, device_platform: platform, device_public_key: public_key, ...pairing } = row;
    return { ...pairing, device: name === null ? null : { name, platform, public_key } };
  }

  /** One more failed claim; at `MAX_FAILED_CLAIMS` the conditional UPDATE of `claimPairing` refuses it. */
  async failPairing(id: string): Promise<void> {
    await this.db.prepare("UPDATE admin_pairings SET failed_attempts = failed_attempts + 1 WHERE id = ?").bind(id).run();
  }

  /**
   * Claims the pairing and creates the pending device, in one transaction. The UPDATE is the
   * only place where "exists, not expired, not claimed, not burned and the secret matches" is
   * decided, so two claims at once cannot both win. `true` if this one did.
   */
  async claimPairing(pairingId: string, secretHash: string, device: NewDevice, maxFailed: number, now: number) {
    const [claimed] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE admin_pairings SET claimed_at = ?, device_id = ?
           WHERE id = ? AND secret_hash = ? AND claimed_at IS NULL AND expires_at >= ? AND failed_attempts < ?`,
        )
        .bind(now, device.id, pairingId, secretHash, now, maxFailed),
      this.db
        .prepare(
          `INSERT INTO admin_devices (id, name, platform, role, public_key, status, created_at)
           SELECT ?, ?, ?, role, ?, 'pending', ? FROM admin_pairings WHERE id = ? AND device_id = ?`,
        )
        .bind(device.id, device.name, device.platform, device.publicKey, now, pairingId, device.id),
    ]);
    return claimed!.meta.changes === 1;
  }

  /** Approves a claimed pairing: the device becomes active, and the `pair` row goes to the log. */
  async approvePairing(p: PairingRow & { device_id: string }, actor: Actor, now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("UPDATE admin_pairings SET approved_at = ? WHERE id = ?").bind(now, p.id),
      this.db.prepare("UPDATE admin_devices SET status = 'active' WHERE id = ?").bind(p.device_id),
      this.adminLogInsert(
        null,
        { action: "pair", kind: null, hash: null, ref: null, note: p.label, device_id: p.device_id, actor },
        now,
      ),
    ]);
  }

  /** Deletes the pairing and, if it was claimed, its pending device. */
  async cancelPairing(id: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM admin_devices WHERE status = 'pending'
           AND id = (SELECT device_id FROM admin_pairings WHERE id = ?)`,
        )
        .bind(id),
      this.db.prepare("DELETE FROM admin_pairings WHERE id = ?").bind(id),
    ]);
  }

  async getDevice(id: string): Promise<DeviceWithPairing | null> {
    return this.db
      .prepare(
        `SELECT ${DEVICE_COLUMNS},
           (SELECT expires_at FROM admin_pairings WHERE device_id = admin_devices.id) AS pairing_expires_at
         FROM admin_devices WHERE id = ?`,
      )
      .bind(id)
      .first<DeviceWithPairing>();
  }

  /** Every device, newest first. */
  async listDevices(): Promise<DeviceRow[]> {
    const { results } = await this.db
      .prepare(`SELECT ${DEVICE_COLUMNS} FROM admin_devices ORDER BY created_at DESC, id DESC`)
      .all<DeviceRow>();
    return results;
  }

  /**
   * Stores a signed request's nonce, after deleting that device's expired ones. `false` if it was
   * already there: a replay.
   */
  async useNonce(deviceId: string, nonce: string, expiresAt: number, now: number): Promise<boolean> {
    const [, inserted] = await this.db.batch([
      this.db.prepare("DELETE FROM admin_nonces WHERE device_id = ? AND expires_at < ?").bind(deviceId, now),
      this.db
        .prepare("INSERT INTO admin_nonces (device_id, nonce, expires_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
        .bind(deviceId, nonce, expiresAt),
    ]);
    return inserted!.meta.changes === 1;
  }

  async touchDevice(id: string, now: number): Promise<void> {
    await this.db.prepare("UPDATE admin_devices SET last_used_at = ? WHERE id = ?").bind(now, id).run();
  }

  /** Revokes the device and writes the `revoke` row, in one transaction. */
  async revokeDevice(id: string, actor: Actor, now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("UPDATE admin_devices SET revoked_at = ? WHERE id = ?").bind(now, id),
      this.adminLogInsert(
        null,
        { action: "revoke", kind: null, hash: null, ref: null, note: null, device_id: id, actor },
        now,
      ),
    ]);
  }

  /**
   * Daily cron: expired nonces, pending devices whose pairing expired, was burned or is gone, and
   * expired pairings (approved or not; an approved device does not need its pairing any more).
   */
  async purgeAdminAuth(now: number, maxFailed: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM admin_nonces WHERE expires_at < ?").bind(now),
      this.db
        .prepare(
          `DELETE FROM admin_devices WHERE status = 'pending' AND id NOT IN (
             SELECT device_id FROM admin_pairings
             WHERE device_id IS NOT NULL AND expires_at >= ? AND failed_attempts < ?)`,
        )
        .bind(now, maxFailed),
      this.db.prepare("DELETE FROM admin_pairings WHERE expires_at < ?").bind(now),
    ]);
  }

  /**
   * One page of `select`, newest first: the filters whose value is not `undefined` (the first one
   * is always the app; a `null` value is a condition without a parameter), then the rows strictly
   * older than `after` in (created_at, key) order. The SQL fragments are constants of this file,
   * never request input; values always go as bound parameters.
   */
  private async page<T>(
    select: string,
    key: string,
    filters: [string, string | number | null | undefined][],
    after: After | null,
    limit: number,
  ): Promise<T[]> {
    const where: string[] = [];
    const values: (string | number)[] = [];
    for (const [condition, value] of filters) {
      if (value === undefined) continue;
      where.push(condition);
      if (value !== null) values.push(value);
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
