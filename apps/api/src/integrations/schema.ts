import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const integrations = sqliteTable(
  "integrations",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    config: text("config", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    // One encrypted map, so a row can carry two secrets.
    secrets: text("secrets"),
    // Set only for a sender that presents a credential to us.
    tokenHash: text("token_hash").unique(),
    lastUsedAt: text("last_used_at"),
    // When the third party last refused the stored credential, and why.
    rejectedAt: text("rejected_at"),
    rejection: text("rejection"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_integrations_name").on(t.name),
    index("idx_integrations_kind").on(t.kind),
  ],
);
