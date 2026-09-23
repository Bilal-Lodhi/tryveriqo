/**
 * In-memory MongoDB driver double shared by the package's tests.
 *
 * Implements only the surface `MongoStore` uses. It is not a MongoDB emulator:
 * an unsupported aggregation stage throws, so a new query shape in the store
 * fails loudly here instead of passing silently.
 */

import type { DbLike } from "@assessment/mcp-mongodb";

export interface FakeDb {
  db: DbLike;
  docs(name: string): Array<Record<string, unknown>>;
}

export function createFakeDb(): FakeDb {
  const collections = new Map<string, Array<Record<string, unknown>>>();
  let objectId = 0;

  function docs(name: string): Array<Record<string, unknown>> {
    let list = collections.get(name);
    if (!list) {
      list = [];
      collections.set(name, list);
    }
    return list;
  }

  function matches(doc: Record<string, unknown>, query: Record<string, unknown>): boolean {
    return Object.entries(query).every(([key, expected]) => {
      // Dotted field paths, which MongoDB resolves natively.
      const actual = key
        .split(".")
        .reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], doc);
      return actual === expected;
    });
  }

  function sortBy(list: Array<Record<string, unknown>>, spec: Record<string, number>) {
    const [[key, direction]] = Object.entries(spec);
    if (!key) return list;
    return [...list].sort((a, b) => {
      const left = a[key];
      const right = b[key];
      if (left === right) return 0;
      return (left! < right! ? -1 : 1) * (direction === -1 ? -1 : 1);
    });
  }

  const collection = (name: string) => ({
    async createIndex(): Promise<string> {
      return `${name}_index`;
    },
    async estimatedDocumentCount(): Promise<number> {
      return docs(name).length;
    },
    async insertOne(doc: Record<string, unknown>) {
      const _id = `id-${(objectId += 1)}`;
      docs(name).push({ ...doc, _id });
      return { insertedId: _id, acknowledged: true };
    },
    async insertMany(inserted: Array<Record<string, unknown>>) {
      for (const doc of inserted) docs(name).push({ ...doc, _id: `id-${(objectId += 1)}` });
      return { insertedCount: inserted.length, acknowledged: true };
    },
    async findOne(query: Record<string, unknown>) {
      return docs(name).find((doc) => matches(doc, query)) ?? null;
    },
    async findOneAndReplace(
      query: Record<string, unknown>,
      replacement: Record<string, unknown>,
      options: { upsert?: boolean; returnDocument?: "before" | "after" } = {},
    ) {
      const list = docs(name);
      const index = list.findIndex((doc) => matches(doc, query));

      if (index === -1) {
        if (!options.upsert) return null;
        const _id = `id-${(objectId += 1)}`;
        const created = { ...replacement, _id };
        list.push(created);
        return options.returnDocument === "before" ? null : created;
      }

      const previous = list[index]!;
      if (options.returnDocument === "before") return previous;
      // A real replace keeps the existing _id; callers rely on it for the
      // returned document id.
      const next = { ...replacement, _id: previous["_id"] };
      list[index] = next;
      return next;
    },
    async updateOne(query: Record<string, unknown>, update: Record<string, unknown>) {
      const doc = docs(name).find((candidate) => matches(candidate, query));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(doc, (update["$set"] as Record<string, unknown>) ?? {});
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async deleteOne(query: Record<string, unknown>) {
      const list = docs(name);
      const index = list.findIndex((doc) => matches(doc, query));
      if (index === -1) return { deletedCount: 0 };
      list.splice(index, 1);
      return { deletedCount: 1 };
    },
    async deleteMany(query: Record<string, unknown>) {
      const list = docs(name);
      const keep = list.filter((doc) => !matches(doc, query));
      const removed = list.length - keep.length;
      collections.set(name, keep);
      return { deletedCount: removed };
    },
    async countDocuments(query: Record<string, unknown>) {
      return docs(name).filter((doc) => matches(doc, query)).length;
    },
    find(
      query: Record<string, unknown> = {},
      options: { projection?: Record<string, number> } = {},
    ) {
      let results = docs(name).filter((doc) => matches(doc, query));
      const chain = {
        sort(spec: Record<string, number>) {
          results = sortBy(results, spec);
          return chain;
        },
        limit(count: number) {
          results = results.slice(0, count);
          return chain;
        },
        async toArray() {
          if (!options.projection) return results.map((doc) => ({ ...doc }));
          return results.map((doc) => {
            const projected: Record<string, unknown> = {};
            for (const [key, include] of Object.entries(options.projection!)) {
              if (include === 1 && key in doc) projected[key] = doc[key];
            }
            return projected;
          });
        },
      };
      return chain;
    },
    aggregate(pipeline: Array<Record<string, unknown>>) {
      let results = [...docs(name)];
      for (const stage of pipeline) {
        if (stage["$match"]) {
          const query = stage["$match"] as Record<string, unknown>;
          results = results.filter((doc) => matches(doc, query));
        } else if (stage["$sort"]) {
          results = sortBy(results, stage["$sort"] as Record<string, number>);
        } else if (stage["$group"]) {
          const group = stage["$group"] as Record<string, unknown>;
          const key = String(group["_id"]).replace("$", "");
          const grouped = new Map<unknown, Record<string, unknown>>();
          for (const doc of results) {
            if (!grouped.has(doc[key])) grouped.set(doc[key], { ...doc });
          }
          results = [...grouped.values()];
        } else if (stage["$replaceRoot"]) {
          continue;
        } else {
          throw new Error(`createFakeDb: unsupported aggregation stage ${Object.keys(stage)[0]}`);
        }
      }
      return {
        async toArray() {
          return results;
        },
      };
    },
  });

  return { db: { collection: (name: string) => collection(name) as never }, docs };
}
