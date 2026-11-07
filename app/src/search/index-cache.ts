export type FacetsData = {
  total: number;
  counts: Record<string, Record<string, number>>;
  bitsets: Record<string, string>;
  ordinals?: string[];
};

const DB_NAME = 'secureflow-search-cache-v1';
const STORE_NAME = 'artifacts';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const target = event?.target as IDBOpenDBRequest | undefined;
        const db = target?.result ?? request.result;
        if (db?.objectStoreNames && !db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    } catch (err) {
      reject(err);
    }
  });
}

export async function getCachedIndex(sha256: string): Promise<string | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(`search-index:${sha256}`);
      req.onsuccess = () => resolve(req.result?.data ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function setCachedIndex(sha256: string, json: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put({ key: `search-index:${sha256}`, sha256, data: json, cachedAt: Date.now() });
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } catch {
    // Ignore cache write errors
  }
}

export async function getCachedFacets(sha256: string): Promise<FacetsData | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(`facets:${sha256}`);
      req.onsuccess = () => resolve(req.result?.data ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function setCachedFacets(sha256: string, facets: FacetsData): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put({ key: `facets:${sha256}`, sha256, data: facets, cachedAt: Date.now() });
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } catch {
    // Ignore cache write errors
  }
}

export async function evictStaleArtifacts(currentSha256: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        if (cursor.value?.sha256 && cursor.value.sha256 !== currentSha256) cursor.delete();
        cursor.continue();
      };
      req.onerror = () => resolve();
    });
  } catch {
    // Ignore eviction errors
  }
}
