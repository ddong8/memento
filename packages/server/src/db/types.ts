import { customType } from "drizzle-orm/pg-core";

/** Postgres tsvector (document_search.content_tsv), read and written as its text form. */
export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});
