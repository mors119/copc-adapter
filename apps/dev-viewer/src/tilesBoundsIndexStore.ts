import type { DecodedContentBoundsIndex } from "@frillab/copc-tiles";

const DATABASE_NAME = "copc-dev-viewer-tiles";
const STORE_NAME = "content-bounds-indexes";
const MAX_ENTRIES = 4;

type StoredIndex = Readonly<{
  sourceFingerprint: string;
  savedAt: number;
  index: DecodedContentBoundsIndex;
}>;

/** Persist only small bounds metadata; point buffers and GLBs are never stored here. */
export async function saveTilesBoundsIndex(index: DecodedContentBoundsIndex): Promise<void> {
  const database = await openDatabase();
  await requestValue(database, (store) => store.put({
    sourceFingerprint: index.sourceFingerprint,
    savedAt: Date.now(),
    index,
  } satisfies StoredIndex));
  const records = await requestValue(database, (store) => store.getAll() as IDBRequest<StoredIndex[]>);
  const stale = records.sort((left, right) => left.savedAt - right.savedAt).slice(0, Math.max(0, records.length - MAX_ENTRIES));
  for (const record of stale) await requestValue(database, (store) => store.delete(record.sourceFingerprint));
  database.close();
}

export async function getTilesBoundsIndex(sourceFingerprint: string): Promise<DecodedContentBoundsIndex | undefined> {
  const database = await openDatabase();
  const stored = await requestValue(database, (store) => store.get(sourceFingerprint) as IDBRequest<StoredIndex | undefined>);
  if (stored) {
    await requestValue(database, (store) => store.put({ ...stored, savedAt: Date.now() }));
  }
  database.close();
  return stored?.index;
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable; a reusable content-bounds index cannot be persisted in this browser."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "sourceFingerprint" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the Dev Viewer bounds-index database."));
  });
}

function requestValue<T>(database: IDBDatabase, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const request = action(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The Dev Viewer bounds-index operation failed."));
    transaction.onerror = () => reject(transaction.error ?? new Error("The Dev Viewer bounds-index transaction failed."));
  });
}
