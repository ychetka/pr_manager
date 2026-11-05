/**
 * Ordered migration registry (roadmap item_04).
 *
 * Migrations are numbered modules (NNN_name.ts); each exports `version`
 * and `up(db)`. SqliteStore applies every migration whose version is
 * greater than the current `PRAGMA user_version`, inside a transaction.
 * Append new modules here in ascending version order - never reorder
 * or edit an applied migration.
 */
import type { Database } from "better-sqlite3";
import { up as up001, version as v001 } from "./001_init.js";

export interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

export const MIGRATIONS: readonly Migration[] = [{ version: v001, name: "001_init", up: up001 }];
