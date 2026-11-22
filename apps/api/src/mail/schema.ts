// One row, id 'mail'. A column is NULL until a person sets it or the environment does.
import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { SMTP_SECURITIES } from "@nightwarden/shared";
import { inList } from "../schema-helpers.js";

export const mailServerConfig = sqliteTable(
  "mail_server",
  {
    id: text("id").primaryKey(),
    host: text("host"),
    port: integer("port"),
    security: text("security", { enum: SMTP_SECURITIES }),
    username: text("username"),
    passwordEncrypted: text("password_encrypted"),
    from: text("from_address"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check(
      "mail_server_security",
      sql`${t.security} IN (${inList(SMTP_SECURITIES)})`,
    ),
  ],
);
