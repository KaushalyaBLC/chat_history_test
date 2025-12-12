/**
 * IndexedDB Manager for storing and querying snapshot messages
 */

export interface Message {
  id: string;
  user_id: string;
  message: string;
  file_url?: string;
  type: string;
  message_type: string;
  mime_type?: string;
  other_data?: any;
  created_at: string;
  structured_message?: any;
  parent_message_id?: string;
  message_state?: string;
  message_sent_by?: string;
  is_reported?: boolean;
  updated_at?: string;
  signature?: string;
  project_id?: number;
  is_new?: string;
  change_type?: string;
  oleon_convos_users?: any;
}

export interface SnapshotMetadata {
  snapshotId: string;
  projectId?: number;
  queueId?: string;
  messageCount: number;
  totalMessages?: number;
  processedMessages: number;
  firstMessageDate?: string;
  lastMessageDate?: string;
  createdAt: string;
  status: 'processing' | 'completed' | 'error';
  error?: string;
}

const DB_NAME = 'SnapshotMessagesDB';
const DB_VERSION = 1;
const MESSAGES_STORE = 'messages';
const METADATA_STORE = 'snapshots';

export class IndexedDBManager {
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase>;

  constructor() {
    this.dbPromise = this.initDB();
  }

  private initDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create messages store
        if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
          const messagesStore = db.createObjectStore(MESSAGES_STORE, {
            keyPath: ['snapshotId', 'id'],
          });
          messagesStore.createIndex('snapshotId', 'snapshotId', { unique: false });
          messagesStore.createIndex('created_at', 'created_at', { unique: false });
          messagesStore.createIndex('user_id', 'user_id', { unique: false });
          messagesStore.createIndex('type', 'type', { unique: false });
        }

        // Create metadata store
        if (!db.objectStoreNames.contains(METADATA_STORE)) {
          const metadataStore = db.createObjectStore(METADATA_STORE, {
            keyPath: 'snapshotId',
          });
          metadataStore.createIndex('createdAt', 'createdAt', { unique: false });
          metadataStore.createIndex('status', 'status', { unique: false });
        }
      };
    });
  }

  async getDB(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    return this.dbPromise;
  }

  /**
   * Save snapshot metadata
   */
  async saveMetadata(metadata: SnapshotMetadata): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([METADATA_STORE], 'readwrite');
      const store = transaction.objectStore(METADATA_STORE);
      const request = store.put(metadata);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get snapshot metadata
   */
  async getMetadata(snapshotId: string): Promise<SnapshotMetadata | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([METADATA_STORE], 'readonly');
      const store = transaction.objectStore(METADATA_STORE);
      const request = store.get(snapshotId);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get all snapshots metadata
   */
  async getAllMetadata(): Promise<SnapshotMetadata[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([METADATA_STORE], 'readonly');
      const store = transaction.objectStore(METADATA_STORE);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Save messages in batch (optimized with parallel puts)
   * Queues all put() operations in parallel within a single transaction
   * for significantly better performance on large batches
   */
  async saveMessagesBatch(
    snapshotId: string,
    messages: Message[],
    onProgress?: (saved: number) => void
  ): Promise<void> {
    const db = await this.getDB();
    const PROGRESS_REPORT_INTERVAL = 100; // Report every 100 messages

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([MESSAGES_STORE], 'readwrite');
      const store = transaction.objectStore(MESSAGES_STORE);

      let completed = 0;
      const totalMessages = messages.length;

      // Queue all put() operations in parallel - don't await each one
      messages.forEach((msg, index) => {
        const message = { ...msg, snapshotId };
        const request = store.put(message);

        request.onsuccess = () => {
          completed++;
          // Only report progress every N messages to reduce overhead
          if (onProgress && (completed % PROGRESS_REPORT_INTERVAL === 0 || completed === totalMessages)) {
            onProgress(completed);
          }
        };

        request.onerror = () => {
          // Don't reject immediately - let transaction handle it
          console.error('Error saving message:', request.error);
        };
      });

      // Wait for transaction to complete, not individual puts
      transaction.oncomplete = () => {
        // Final progress update
        if (onProgress && completed !== totalMessages) {
          onProgress(completed);
        }
        resolve();
      };

      transaction.onerror = () => {
        reject(transaction.error || new Error('Transaction failed'));
      };

      transaction.onabort = () => {
        reject(new Error('Transaction aborted'));
      };
    });
  }

  /**
   * @deprecated Use saveMessagesBatch (now optimized) instead
   * Legacy sequential implementation - kept for reference
   */
  async saveMessagesBatchSequential(
    snapshotId: string,
    messages: Message[],
    onProgress?: (saved: number) => void
  ): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([MESSAGES_STORE], 'readwrite');
      const store = transaction.objectStore(MESSAGES_STORE);

      let saved = 0;
      const totalMessages = messages.length;

      const saveNext = (index: number) => {
        if (index >= totalMessages) {
          resolve();
          return;
        }

        const message = { ...messages[index], snapshotId };
        const request = store.put(message);

        request.onsuccess = () => {
          saved++;
          if (onProgress) onProgress(saved);
          saveNext(index + 1);
        };

        request.onerror = () => reject(request.error);
      };

      saveNext(0);
    });
  }

  /**
   * Get messages for a snapshot with pagination
   */
  async getMessages(
    snapshotId: string,
    options: {
      offset?: number;
      limit?: number;
      orderBy?: 'created_at';
      order?: 'asc' | 'desc';
    } = {}
  ): Promise<Message[]> {
    const { offset = 0, limit = 100, order = 'asc' } = options;
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([MESSAGES_STORE], 'readonly');
      const store = transaction.objectStore(MESSAGES_STORE);
      const index = store.index('snapshotId');
      const request = index.openCursor(
        IDBKeyRange.only(snapshotId),
        order === 'desc' ? 'prev' : 'next'
      );

      const messages: Message[] = [];
      let currentOffset = 0;

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;

        if (!cursor || messages.length >= limit) {
          resolve(messages);
          return;
        }

        if (currentOffset >= offset) {
          const { snapshotId: _, ...message } = cursor.value;
          messages.push(message);
        }

        currentOffset++;
        cursor.continue();
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get total message count for a snapshot
   */
  async getMessageCount(snapshotId: string): Promise<number> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([MESSAGES_STORE], 'readonly');
      const store = transaction.objectStore(MESSAGES_STORE);
      const index = store.index('snapshotId');
      const request = index.count(IDBKeyRange.only(snapshotId));

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Search messages by text
   */
  async searchMessages(
    snapshotId: string,
    searchText: string,
    limit: number = 50
  ): Promise<Message[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([MESSAGES_STORE], 'readonly');
      const store = transaction.objectStore(MESSAGES_STORE);
      const index = store.index('snapshotId');
      const request = index.openCursor(IDBKeyRange.only(snapshotId));

      const messages: Message[] = [];
      const searchLower = searchText.toLowerCase();

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;

        if (!cursor || messages.length >= limit) {
          resolve(messages);
          return;
        }

        const message = cursor.value;
        if (message.message?.toLowerCase().includes(searchLower)) {
          const { snapshotId: _, ...msg } = message;
          messages.push(msg);
        }

        cursor.continue();
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Delete all data for a snapshot
   */
  async deleteSnapshot(snapshotId: string): Promise<void> {
    const db = await this.getDB();

    // Delete messages
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([MESSAGES_STORE], 'readwrite');
      const store = transaction.objectStore(MESSAGES_STORE);
      const index = store.index('snapshotId');
      const request = index.openCursor(IDBKeyRange.only(snapshotId));

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };

      request.onerror = () => reject(request.error);
    });

    // Delete metadata
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([METADATA_STORE], 'readwrite');
      const store = transaction.objectStore(METADATA_STORE);
      const request = store.delete(snapshotId);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear all data
   */
  async clearAll(): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [MESSAGES_STORE, METADATA_STORE],
        'readwrite'
      );

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);

      transaction.objectStore(MESSAGES_STORE).clear();
      transaction.objectStore(METADATA_STORE).clear();
    });
  }
}
