const DB_NAME = 'SnapshotStagingDB';
const DB_VERSION = 1;
const STORE_NAME = 'staged_snapshots';

export interface StagedSnapshotRecord {
  snapshotId: string;
  decryptedData: any;
  decryptDurationMs: number;
  approxSizeMb?: number;
  createdAt: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'snapshotId' });
      }
    };

    request.onsuccess = () => resolve(request.result);
  });

  return dbPromise;
}

export async function saveStagedSnapshot(
  record: StagedSnapshotRecord
): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function loadStagedSnapshot(
  snapshotId: string
): Promise<StagedSnapshotRecord | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(snapshotId);
    request.onsuccess = () => resolve((request.result as StagedSnapshotRecord) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteStagedSnapshot(snapshotId: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(snapshotId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function clearAllStagedSnapshots(): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
