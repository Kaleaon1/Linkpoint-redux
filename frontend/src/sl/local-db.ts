// On-device replacement for the Mongo collections the old backend used.
// Same shape (find / findOne / insertOne / insertMany / updateOne / updateMany
// / replaceOne / deleteMany), backed by AsyncStorage instead of a server so
// server.py's Mongo-flavoured queries port over almost verbatim.
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

type Doc = Record<string, any>;
type Query = Record<string, any>;

function matchesValue(actual: any, expected: any): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if ("$in" in expected) return (expected.$in as any[]).includes(actual);
    if ("$nin" in expected) return !(expected.$nin as any[]).includes(actual);
    if ("$ne" in expected) return actual !== expected.$ne;
  }
  return actual === expected;
}

function matches(doc: Doc, query: Query): boolean {
  return Object.entries(query).every(([k, v]) => matchesValue(doc[k], v));
}

class Collection {
  private cache: Doc[] | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private name: string) {}

  private key() {
    return `gridlink.db.${this.name}`;
  }

  private async load(): Promise<Doc[]> {
    if (this.cache) return this.cache;
    const raw = await AsyncStorage.getItem(this.key());
    this.cache = raw ? JSON.parse(raw) : [];
    return this.cache!;
  }

  /** Serializes writes so concurrent callers (router + circuit threads) never race a read-modify-write. */
  private mutate<T>(fn: (docs: Doc[]) => T): Promise<T> {
    const run = this.writeChain.then(async () => {
      const docs = await this.load();
      const result = fn(docs);
      this.cache = docs;
      await AsyncStorage.setItem(this.key(), JSON.stringify(docs));
      return result;
    });
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async findOne(query: Query = {}): Promise<Doc | null> {
    const docs = await this.load();
    return docs.find((d) => matches(d, query)) ?? null;
  }

  async find(query: Query = {}): Promise<Doc[]> {
    const docs = await this.load();
    return docs.filter((d) => matches(d, query));
  }

  async insertOne(doc: Doc): Promise<void> {
    await this.mutate((docs) => {
      docs.push({ ...doc });
    });
  }

  async insertMany(items: Doc[]): Promise<void> {
    if (!items.length) return;
    await this.mutate((docs) => {
      docs.push(...items.map((d) => ({ ...d })));
    });
  }

  async updateOne(query: Query, update: { $set?: Doc }, opts: { upsert?: boolean } = {}): Promise<void> {
    await this.mutate((docs) => {
      const idx = docs.findIndex((d) => matches(d, query));
      const set = update.$set ?? {};
      if (idx >= 0) {
        docs[idx] = { ...docs[idx], ...set };
      } else if (opts.upsert) {
        const base: Doc = {};
        for (const [k, v] of Object.entries(query)) {
          if (typeof v !== "object" || v === null) base[k] = v;
        }
        docs.push({ ...base, ...set });
      }
    });
  }

  async updateMany(query: Query, update: { $set?: Doc }): Promise<void> {
    await this.mutate((docs) => {
      const set = update.$set ?? {};
      for (const d of docs) {
        if (matches(d, query)) Object.assign(d, set);
      }
    });
  }

  async replaceOne(query: Query, doc: Doc, opts: { upsert?: boolean } = {}): Promise<void> {
    await this.mutate((docs) => {
      const idx = docs.findIndex((d) => matches(d, query));
      if (idx >= 0) docs[idx] = { ...doc };
      else if (opts.upsert) docs.push({ ...doc });
    });
  }

  async deleteMany(query: Query): Promise<void> {
    await this.mutate((docs) => {
      for (let i = docs.length - 1; i >= 0; i--) {
        if (matches(docs[i], query)) docs.splice(i, 1);
      }
    });
  }

  /** Test-only: drop the in-memory cache so the next read re-fetches from AsyncStorage. */
  __resetCache(): void {
    this.cache = null;
  }
}

class LocalDB {
  sessions = new Collection("sessions");
  friends = new Collection("friends");
  inventory = new Collection("inventory");
  groups = new Collection("groups");
  chat = new Collection("chat");
  friend_requests = new Collection("friend_requests");
  read_marks = new Collection("read_marks");

  /** Test-only: call after AsyncStorage.clear() so cached collections don't serve stale data. */
  __resetForTests(): void {
    for (const col of Object.values(this)) {
      if (col instanceof Collection) col.__resetCache();
    }
  }
}

export const db = new LocalDB();

// ---------------------------------------------------------------------------
// Stored login credentials (the "$1$"+md5 password hash SL accepts for login,
// never the plaintext) live in SecureStore, not the plain AsyncStorage-backed
// collections above, since they're the one thing here sensitive enough to
// warrant the OS keychain / Keystore.
// ---------------------------------------------------------------------------
export type LoginCreds = {
  first: string;
  last: string;
  passwd_hash: string;
  grid: "agni" | "aditi";
  start: string;
};

const credsKey = (sessionId: string) => `gridlink.creds.${sessionId}`;

export const secureCreds = {
  async save(sessionId: string, creds: LoginCreds): Promise<void> {
    await SecureStore.setItemAsync(credsKey(sessionId), JSON.stringify(creds));
  },
  async load(sessionId: string): Promise<LoginCreds | null> {
    const raw = await SecureStore.getItemAsync(credsKey(sessionId));
    return raw ? JSON.parse(raw) : null;
  },
  async clear(sessionId: string): Promise<void> {
    await SecureStore.deleteItemAsync(credsKey(sessionId));
  },
};
