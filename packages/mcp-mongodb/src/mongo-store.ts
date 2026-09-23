/**
 * MongoDB data layer for the Assessment integrity store.
 *
 * Uses the official MongoDB Node.js driver directly, with no ORM. Collection
 * names come from `collections.ts` so that readers and writers cannot drift
 * apart, and every index the application relies on is created in
 * `ensureIndexes()`.
 *
 * The store accepts an optional injected handle (see `DbLike`) so the data
 * layer can be exercised by automated tests without a live MongoDB instance.
 */

import { MongoClient, Db, Collection, Document } from "mongodb";
import { COLLECTIONS, DEFAULT_DATABASE_NAME, type CollectionName } from "./collections.js";

export interface MongoConfig {
  uri: string;
  databaseName: string;
}

/**
 * Minimal structural view of the MongoDB driver API this store uses.
 * A real `Db` satisfies it, and so does a lightweight in-memory fake.
 */
export interface DbLike {
  collection(name: string): Collection<Document>;
}

/** Factory for the underlying database handle. Defaults to a real MongoClient. */
export type DbProvider = (uri: string, databaseName: string) => Promise<DbLike>;

interface ActiveConnection {
  readonly handle: DbLike;
  close(): Promise<void>;
}

async function connectWithDriver(uri: string, databaseName: string): Promise<ActiveConnection> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  const db: Db = client.db(databaseName);
  return {
    handle: db,
    close: () => client.close(),
  };
}

export interface MongoStoreOptions {
  uri?: string;
  databaseName?: string;
  /**
   * Overrides how the database handle is obtained. Used by tests to inject an
   * in-memory fake; production always uses the real MongoDB driver.
   */
  connect?: (uri: string, databaseName: string) => Promise<ActiveConnection>;
}

export class MongoStore {
  private readonly uri: string;
  private readonly databaseName: string;
  private readonly connectFn: (uri: string, databaseName: string) => Promise<ActiveConnection>;
  private connection: ActiveConnection | null = null;

  constructor(options: MongoStoreOptions = {}) {
    this.uri =
      options.uri ?? process.env["MONGODB_URI"] ?? "mongodb://127.0.0.1:27017";
    this.databaseName =
      options.databaseName ??
      process.env["MONGODB_DATABASE"] ??
      DEFAULT_DATABASE_NAME;
    this.connectFn = options.connect ?? connectWithDriver;
  }

  async connect(): Promise<void> {
    if (this.connection) return;
    this.connection = await this.connectFn(this.uri, this.databaseName);
    await this.ensureIndexes();
  }

  async disconnect(): Promise<void> {
    if (!this.connection) return;
    const active = this.connection;
    this.connection = null;
    await active.close();
  }

  get databaseNameInUse(): string {
    return this.databaseName;
  }

  private dbOrThrow(): DbLike {
    if (!this.connection) {
      throw new Error("MongoDB is not connected — call connect() first.");
    }
    return this.connection.handle;
  }

  private collection(name: CollectionName): Collection<Document> {
    return this.dbOrThrow().collection(COLLECTIONS[name]);
  }

  // ─── Indexes ─────────────────────────────────────────────────────

  /**
   * Creates every index the application depends on. Safe to call repeatedly;
   * MongoDB treats an identical `createIndex` as a no-op.
   */
  async ensureIndexes(): Promise<void> {
    const sessions = this.collection("sessions");
    const microEvents = this.collection("microEvents");
    const integrityReports = this.collection("integrityReports");
    const testSuites = this.collection("testSuites");

    await Promise.all([
      sessions.createIndex({ sessionId: 1 }, { unique: true }),
      sessions.createIndex({ candidateId: 1, assessmentId: 1 }),
      sessions.createIndex({ createdAt: -1 }),

      microEvents.createIndex({ sessionId: 1, timestamp: -1 }),
      microEvents.createIndex({ eventType: 1 }),

      integrityReports.createIndex({ sessionId: 1, generatedAt: -1 }),
      integrityReports.createIndex({ candidateId: 1 }),

      testSuites.createIndex({ "metadata.suiteId": 1 }, { unique: true }),
      testSuites.createIndex({ "metadata.generatedAt": -1 }),
    ]);
  }

  // ─── Assessment suites ───────────────────────────────────────────

  async storeTestSuite(suite: Document): Promise<string> {
    // The suite document is stored as-is: its `metadata` sub-document holds the
    // suiteId that `getTestSuite` indexes and reads on.
    //
    // Storing is idempotent on that suiteId. `metadata.suiteId` carries a unique
    // index, so a plain insert turns a re-generation or a client retry into a
    // duplicate-key failure and silently loses the newer suite. Upserting keeps
    // one document per suite id: a repeat replaces it, which is the correct
    // outcome because the two documents are the same suite.
    const suiteId = (suite["metadata"] as Document | undefined)?.["suiteId"];

    if (typeof suiteId !== "string" || suiteId.length === 0) {
      // Without a suite id there is nothing to be idempotent on; insert and let
      // the caller receive a real document id.
      const inserted = await this.collection("testSuites").insertOne({
        ...suite,
        storedAt: new Date(),
      });
      return inserted.insertedId.toString();
    }

    const result = await this.collection("testSuites").findOneAndReplace(
      { "metadata.suiteId": suiteId },
      { ...suite, storedAt: new Date() },
      { upsert: true, returnDocument: "after" },
    );

    return result?._id?.toString() ?? suiteId;
  }

  async getTestSuite(suiteId: string): Promise<Document | null> {
    return this.collection("testSuites").findOne({ "metadata.suiteId": suiteId });
  }

  // ─── Assessment sessions ─────────────────────────────────────────

  async createSession(session: Document): Promise<string> {
    // Idempotent: ingesting telemetry may race ahead of an explicit session
    // creation, and a duplicate key must not destroy the caller's request.
    const existing = await this.collection("sessions").findOne({
      sessionId: session["sessionId"],
    });
    if (existing) return existing._id.toString();

    const result = await this.collection("sessions").insertOne({
      ...session,
      status: session["status"] ?? "in_progress",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return result.insertedId.toString();
  }

  async getSession(sessionId: string): Promise<Document | null> {
    return this.collection("sessions").findOne({ sessionId });
  }

  async updateSession(sessionId: string, update: Document): Promise<boolean> {
    const result = await this.collection("sessions").updateOne(
      { sessionId },
      { $set: { ...update, updatedAt: new Date() } },
    );
    return result.matchedCount > 0;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const sessionResult = await this.collection("sessions").deleteOne({ sessionId });
    await Promise.all([
      this.collection("microEvents").deleteMany({ sessionId }),
      this.collection("integrityReports").deleteMany({ sessionId }),
    ]);
    return sessionResult.deletedCount > 0;
  }

  async listSessions(): Promise<Document[]> {
    return this.collection("sessions")
      .find(
        {},
        {
          projection: {
            sessionId: 1,
            candidateId: 1,
            assessmentId: 1,
            status: 1,
            createdAt: 1,
            updatedAt: 1,
            _id: 0,
          },
        },
      )
      .sort({ createdAt: -1 })
      .toArray();
  }

  // ─── Telemetry micro-events ──────────────────────────────────────

  async ingestMicroEvents(events: Document[]): Promise<number> {
    if (events.length === 0) return 0;
    const enriched = events.map((event) => ({
      ...event,
      ingestedAt: new Date(),
    }));
    const result = await this.collection("microEvents").insertMany(enriched);
    return result.insertedCount;
  }

  async getSessionEvents(
    sessionId: string,
    options?: { limit?: number; eventType?: string },
  ): Promise<Document[]> {
    const query: Document = { sessionId };
    if (options?.eventType) {
      query["eventType"] = options.eventType;
    }
    return this.collection("microEvents")
      .find(query)
      .sort({ timestamp: -1 })
      .limit(options?.limit ?? 500)
      .toArray();
  }

  async countEventType(sessionId: string, eventType: string): Promise<number> {
    return this.collection("microEvents").countDocuments({ sessionId, eventType });
  }

  // ─── Integrity reports ───────────────────────────────────────────

  async storeIntegrityReport(report: Document): Promise<string> {
    const result = await this.collection("integrityReports").insertOne({
      ...report,
      storedAt: new Date(),
    });
    return result.insertedId.toString();
  }

  async getIntegrityReports(sessionId: string): Promise<Document[]> {
    return this.collection("integrityReports")
      .find({ sessionId })
      .sort({ generatedAt: -1 })
      .toArray();
  }

  /**
   * Latest integrity report per session, for an aggregate candidate view.
   * Older reports for the same session are deliberately excluded.
   */
  async getCandidateReport(candidateId: string): Promise<Document[]> {
    return this.collection("integrityReports")
      .aggregate([
        { $match: { candidateId } },
        { $sort: { generatedAt: -1 } },
        {
          $group: {
            _id: "$sessionId",
            latest: { $first: "$$ROOT" },
          },
        },
        { $replaceRoot: { newRoot: "$latest" } },
        { $sort: { generatedAt: -1 } },
      ])
      .toArray();
  }

  // ─── Health ──────────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    try {
      await this.dbOrThrow().collection(COLLECTIONS.sessions).estimatedDocumentCount();
      return true;
    } catch {
      return false;
    }
  }

  isConnected(): boolean {
    return this.connection !== null;
  }
}
