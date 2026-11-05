/**
 * Migration 001 - initial schema (roadmap item_04).
 *
 * Creates the four contract tables plus the ingest bookkeeping index.
 * Applied inside a transaction by SqliteStore.migrate(); the applied
 * version is tracked via `PRAGMA user_version` (the "schema_version"
 * tracking of the store contract).
 */
import type { Database } from "better-sqlite3";

export const version = 1;

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE content_items (
      id             TEXT PRIMARY KEY,
      source_kind    TEXT NOT NULL,
      external_id    TEXT, -- item's own external id, NULL when absent/blank
      dedupe_key     TEXT NOT NULL, -- resolved idempotency external_id (falls back to id)
      status         TEXT NOT NULL,
      platform_refs  TEXT NOT NULL DEFAULT '[]',
      published_urls TEXT NOT NULL DEFAULT '[]',
      objective      TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      published_at   TEXT,
      raw            TEXT,
      UNIQUE (source_kind, dedupe_key)
    );
    CREATE INDEX idx_content_items_status ON content_items (status);

    CREATE TABLE metrics (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id  TEXT NOT NULL,
      platform TEXT NOT NULL,
      ts       TEXT NOT NULL,
      views    INTEGER,
      likes    INTEGER,
      comments INTEGER,
      raw      TEXT
    );
    CREATE INDEX idx_metrics_item_ts ON metrics (item_id, ts);

    CREATE TABLE recommendations (
      id        TEXT PRIMARY KEY,
      ts        TEXT NOT NULL,
      topic     TEXT NOT NULL,
      objective TEXT NOT NULL,
      platform  TEXT NOT NULL,
      status    TEXT NOT NULL
    );
    CREATE INDEX idx_recommendations_status_ts ON recommendations (status, ts);

    CREATE TABLE profile_reports (
      id       TEXT PRIMARY KEY,
      ts       TEXT NOT NULL,
      platform TEXT NOT NULL,
      findings TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX idx_profile_reports_platform_ts ON profile_reports (platform, ts);
  `);
}
