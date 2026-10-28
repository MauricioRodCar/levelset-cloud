import { index, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./accounts";
import { id, tstz, versioned } from "./columns";
import { importClassification, importGroupKind, importOutcome, importResolution, importState } from "./enums";

/** Re-uploading the same file is a no-op: `file_hash` is unique (FR-32). */
export const importBatches = pgTable("import_batches", {
  id: id(),
  fileHash: text("file_hash").notNull().unique(),
  fileName: text("file_name").notNull(),
  state: importState("state").notNull().default("uploaded"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  report: jsonb("report"),
  committedAt: tstz("committed_at"),
  ...versioned,
});

export const importGroups = pgTable(
  "import_groups",
  {
    id: id(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => importBatches.id),
    email: text("email").notNull(),
    kind: importGroupKind("kind").notNull(),
    resolution: importResolution("resolution"),
    chosenRowId: uuid("chosen_row_id"),
    ...versioned,
  },
  (t) => [unique("import_groups_batch_email_uq").on(t.batchId, t.email)],
);

export const importRows = pgTable(
  "import_rows",
  {
    id: id(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => importBatches.id),
    rowNumber: integer("row_number").notNull(),
    rowHash: text("row_hash").notNull(),
    raw: jsonb("raw").notNull(),
    normalized: jsonb("normalized"),
    classification: importClassification("classification"),
    reason: text("reason"),
    groupId: uuid("group_id").references(() => importGroups.id),
    outcome: importOutcome("outcome"),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [unique("import_rows_batch_row_uq").on(t.batchId, t.rowNumber), index("import_rows_group_idx").on(t.groupId)],
);
