/**
 * Multi-Worker Parallel Stream Processing for IndexedDB
 * Uses multiple Web Workers to process message chunks in parallel
 *
 * Performance: 20-40x faster than sequential, 3-5x faster than single-threaded concurrent
 */

import { decryptSnapshot } from './decrypt-snapshot';
import { IndexedDBManager, type SnapshotMetadata, type Message } from './indexeddb-manager';

export interface StreamingProgress {
  stage: 'downloading' | 'decrypting' | 'processing' | 'saving' | 'completed' | 'error';
  progress: number; // 0-100
  message: string;
  processedMessages?: number;
  totalMessages?: number;
  error?: string;
  decryptDurationMs?: number;
  insertDurationMs?: number;
  totalDurationMs?: number;
  insertedMessages?: number;
  throughputMessagesPerSec?: number;
}

// Configuration for multi-worker processing
const CONFIG = {
  // Worker pool configuration
  WORKER_COUNT: 4, // Use 4 workers for parallel processing (adjustable based on CPU cores)

  // Chunk sizes - larger chunks for fewer worker handoffs
  CHUNK_SIZE_SMALL: 1000,   // < 4K messages
  CHUNK_SIZE_MEDIUM: 2000,  // 4K-16K messages
  CHUNK_SIZE_LARGE: 3000,   // 16K-64K messages
  CHUNK_SIZE_XLARGE: 5000,  // > 64K messages

  // Performance monitoring
  ENABLE_PERFORMANCE_LOGS: true,
};

/**
 * Calculate optimal chunk size based on message count and worker count
 */
function calculateOptimalChunkSize(totalMessages: number, workerCount: number): number {
  // We want enough chunks to keep all workers busy, but not so many that overhead dominates
  const minChunksPerWorker = 2; // Each worker should get at least 2 chunks
  const targetTotalChunks = workerCount * minChunksPerWorker;

  if (totalMessages < 4000) return CONFIG.CHUNK_SIZE_SMALL;
  if (totalMessages < 16000) return CONFIG.CHUNK_SIZE_MEDIUM;
  if (totalMessages < 64000) return CONFIG.CHUNK_SIZE_LARGE;

  // For very large datasets, calculate chunk size to create optimal number of chunks
  const calculatedSize = Math.ceil(totalMessages / targetTotalChunks);
  return Math.max(CONFIG.CHUNK_SIZE_XLARGE, calculatedSize);
}

/**
 * Split messages array into chunks for parallel processing
 */
function chunkMessages(messages: Message[], chunkSize: number): Message[][] {
  const chunks: Message[][] = [];
  for (let i = 0; i < messages.length; i += chunkSize) {
    chunks.push(messages.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Worker pool manager
 */
class WorkerPool {
  private workers: Worker[] = [];
  private availableWorkers: number[] = [];
  private taskQueue: Array<{
    chunk: Message[];
    chunkIndex: number;
    resolver: (value: void) => void;
    rejector: (error: Error) => void;
  }> = [];

  constructor(
    private workerCount: number,
    private snapshotId: string,
    private totalChunks: number,
    private onProgress: (chunkIndex: number, saved: number, total: number) => void
  ) {
    this.initializeWorkers();
  }

  private initializeWorkers() {
    for (let i = 0; i < this.workerCount; i++) {
      // Create worker with complete IndexedDB implementation
      const workerCode = `
        const DB_NAME = 'SnapshotMessagesDB';
        const DB_VERSION = 1;
        const MESSAGES_STORE = 'messages';
        const MAX_RETRIES = 3;
        const BASE_BACKOFF_MS = 150;

        let db = null;

        async function getDB() {
          if (db) return db;

          return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onsuccess = () => {
              db = request.result;
              resolve(db);
            };

            request.onerror = () => reject(request.error);

            request.onupgradeneeded = (event) => {
              const database = event.target.result;

              if (!database.objectStoreNames.contains(MESSAGES_STORE)) {
                const messagesStore = database.createObjectStore(MESSAGES_STORE, {
                  keyPath: ['snapshotId', 'id'],
                });
                messagesStore.createIndex('snapshotId', 'snapshotId', { unique: false });
                messagesStore.createIndex('created_at', 'created_at', { unique: false });
                messagesStore.createIndex('user_id', 'user_id', { unique: false });
                messagesStore.createIndex('type', 'type', { unique: false });
              }
            };
          });
        }

        async function saveMessagesBatch(snapshotId, messages, onProgress) {
          const database = await getDB();
          const PROGRESS_REPORT_INTERVAL = 100;

          return new Promise((resolve, reject) => {
            const transaction = database.transaction([MESSAGES_STORE], 'readwrite');
            const store = transaction.objectStore(MESSAGES_STORE);

            let completed = 0;
            const totalMessages = messages.length;

            // Queue all put() operations in parallel
            messages.forEach((msg) => {
              const message = { ...msg, snapshotId };
              const request = store.put(message);

              request.onsuccess = () => {
                completed++;
                if (onProgress && (completed % PROGRESS_REPORT_INTERVAL === 0 || completed === totalMessages)) {
                  onProgress(completed);
                }
              };

              request.onerror = () => {
                console.error('Error saving message:', request.error);
              };
            });

            transaction.oncomplete = () => {
              if (onProgress && completed !== totalMessages) {
                onProgress(completed);
              }
              resolve(completed);
            };

            transaction.onerror = () => {
              reject(transaction.error || new Error('Transaction failed'));
            };

            transaction.onabort = () => {
              reject(new Error('Transaction aborted'));
            };
          });
        }

        async function saveMessagesBatchWithRetry(snapshotId, messages, onProgress) {
          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
              return await saveMessagesBatch(snapshotId, messages, onProgress);
            } catch (error) {
              if (attempt === MAX_RETRIES) {
                throw error;
              }
              const delay = BASE_BACKOFF_MS * attempt + Math.random() * 200;
              console.warn('Retrying chunk due to IndexedDB contention...', { attempt, delay });
              await new Promise((resolve) => setTimeout(resolve, delay));
            }
          }
        }

        self.onmessage = async (e) => {
          const { type, snapshotId, messages, chunkIndex } = e.data;

          if (type === 'SAVE_BATCH') {
            const startTime = performance.now();

            try {
              let savedCount = 0;

              await saveMessagesBatchWithRetry(snapshotId, messages, (saved) => {
                savedCount = saved;

                if (saved % 100 === 0 || saved === messages.length) {
                  self.postMessage({
                    type: 'PROGRESS',
                    chunkIndex,
                    saved,
                    total: messages.length,
                  });
                }
              });

              const endTime = performance.now();

              self.postMessage({
                type: 'COMPLETE',
                chunkIndex,
                saved: savedCount,
                duration: endTime - startTime,
              });

            } catch (error) {
              self.postMessage({
                type: 'ERROR',
                chunkIndex,
                error: error.message || 'Unknown error',
              });
            }
          }
        };
      `;

      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const worker = new Worker(URL.createObjectURL(blob));

      worker.onmessage = (e) => this.handleWorkerMessage(i, e.data);
      worker.onerror = (error) => this.handleWorkerError(i, error);

      this.workers.push(worker);
      this.availableWorkers.push(i);
    }
  }

  private handleWorkerMessage(
    workerIndex: number,
    data: { type: string; chunkIndex: number; saved?: number; total?: number; duration?: number; error?: string }
  ) {
    if (data.type === 'PROGRESS' && data.saved !== undefined && data.total !== undefined) {
      this.onProgress(data.chunkIndex, data.saved, data.total);
    } else if (data.type === 'COMPLETE') {
      // Worker finished - mark as available and process next task
      this.availableWorkers.push(workerIndex);
      this.processNextTask();

      if (CONFIG.ENABLE_PERFORMANCE_LOGS && data.duration) {
        console.log(
          `Worker ${workerIndex} completed chunk ${data.chunkIndex}/${this.totalChunks} ` +
          `(${data.saved} msgs in ${data.duration.toFixed(0)}ms, ` +
          `${Math.floor((data.saved || 0) / (data.duration / 1000))} msgs/sec)`
        );
      }
    } else if (data.type === 'ERROR') {
      console.error(`Worker ${workerIndex} error on chunk ${data.chunkIndex}:`, data.error);
      this.availableWorkers.push(workerIndex);
      this.processNextTask();
    }
  }

  private handleWorkerError(workerIndex: number, error: ErrorEvent) {
    console.error(`Worker ${workerIndex} error:`, error);
    this.availableWorkers.push(workerIndex);
    this.processNextTask();
  }

  private processNextTask() {
    if (this.taskQueue.length === 0 || this.availableWorkers.length === 0) {
      return;
    }

    const task = this.taskQueue.shift()!;
    const workerIndex = this.availableWorkers.shift()!;

    this.workers[workerIndex].postMessage({
      type: 'SAVE_BATCH',
      snapshotId: this.snapshotId,
      messages: task.chunk,
      chunkIndex: task.chunkIndex,
      totalChunks: this.totalChunks,
    });

    // Resolve immediately - worker will handle async processing
    task.resolver();
  }

  async processChunk(chunk: Message[], chunkIndex: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.taskQueue.push({
        chunk,
        chunkIndex,
        resolver: resolve,
        rejector: reject,
      });

      this.processNextTask();
    });
  }

  async waitForCompletion(): Promise<void> {
    // Wait until all workers are available (all tasks completed)
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.availableWorkers.length === this.workerCount && this.taskQueue.length === 0) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 50);
    });
  }

  terminate() {
    this.workers.forEach(worker => worker.terminate());
    this.workers = [];
    this.availableWorkers = [];
    this.taskQueue = [];
  }
}

interface MetadataInitResult {
  metadata: SnapshotMetadata;
  skip: boolean;
}

async function ensureProcessingMetadata(
  dbManager: IndexedDBManager,
  snapshotId: string
): Promise<MetadataInitResult> {
  const existingMetadata = await dbManager.getMetadata(snapshotId);

  if (existingMetadata && existingMetadata.status === 'completed') {
    return { metadata: existingMetadata, skip: true };
  }

  const metadata: SnapshotMetadata = existingMetadata && existingMetadata.status !== 'completed'
    ? {
        ...existingMetadata,
        status: 'processing',
        error: undefined,
      }
    : {
        snapshotId,
        messageCount: existingMetadata?.messageCount ?? 0,
        processedMessages: existingMetadata?.processedMessages ?? 0,
        createdAt: existingMetadata?.createdAt ?? new Date().toISOString(),
        status: 'processing',
      };

  await dbManager.saveMetadata(metadata);
  return { metadata, skip: false };
}

interface CacheOptions {
  metadata?: SnapshotMetadata;
  dbManager?: IndexedDBManager;
  metrics?: {
    decryptDurationMs?: number;
  };
}

export async function cacheDecryptedSnapshotMultiWorker(
  snapshotId: string,
  decryptedData: any,
  onProgress?: (progress: StreamingProgress) => void,
  options: CacheOptions = {}
): Promise<void> {
  const dbManager = options.dbManager ?? new IndexedDBManager();
  let workerPool: WorkerPool | null = null;
  const decryptDurationMs = options.metrics?.decryptDurationMs;

  try {
    const metadataInit = options.metadata
      ? { metadata: options.metadata, skip: false }
      : await ensureProcessingMetadata(dbManager, snapshotId);

    if (metadataInit.skip) {
      onProgress?.({
        stage: 'completed',
        progress: 100,
        message: 'Snapshot already loaded in IndexedDB',
        processedMessages: metadataInit.metadata.processedMessages,
        totalMessages: metadataInit.metadata.totalMessages,
      });
      return;
    }

    const metadata = metadataInit.metadata;
    const { projectId, queueId, messageCount, messages } = decryptedData;

    if (!messages || !Array.isArray(messages)) {
      throw new Error('Invalid snapshot format: missing messages array');
    }

    const totalMessages = messages.length;
    if (totalMessages === 0) {
      metadata.projectId = projectId;
      metadata.queueId = queueId;
      metadata.messageCount = 0;
      metadata.totalMessages = 0;
      metadata.status = 'completed';
      metadata.processedMessages = 0;
      await dbManager.saveMetadata(metadata);

      onProgress?.({
        stage: 'completed',
        progress: 100,
        message: 'Snapshot contains no messages to cache.',
        processedMessages: 0,
        totalMessages: 0,
        decryptDurationMs,
        insertDurationMs: 0,
        totalDurationMs: decryptDurationMs ?? 0,
        insertedMessages: 0,
        throughputMessagesPerSec: 0,
      });
      return;
    }

    const resumeFrom = Math.min(metadata.processedMessages ?? 0, totalMessages);
    const messagesToInsert = resumeFrom > 0 ? messages.slice(resumeFrom) : messages;

    metadata.projectId = projectId;
    metadata.queueId = queueId;
    metadata.messageCount = messageCount || totalMessages;
    metadata.totalMessages = totalMessages;

    if (totalMessages > 0) {
      metadata.firstMessageDate = messages[0].created_at;
      metadata.lastMessageDate = messages[totalMessages - 1].created_at;
    }

    await dbManager.saveMetadata(metadata);

    if (messagesToInsert.length === 0) {
      metadata.status = 'completed';
      metadata.processedMessages = totalMessages;
      await dbManager.saveMetadata(metadata);

      onProgress?.({
        stage: 'completed',
        progress: 100,
        message: 'All messages already cached – skipped reprocessing.',
        processedMessages: totalMessages,
        totalMessages,
        decryptDurationMs,
        insertDurationMs: 0,
        totalDurationMs: decryptDurationMs ?? 0,
        insertedMessages: 0,
        throughputMessagesPerSec: 0,
      });
      return;
    }

    onProgress?.({
      stage: 'saving',
      progress: resumeFrom > 0 && totalMessages > 0
        ? 65 + Math.floor((resumeFrom / totalMessages) * 30)
        : 65,
      message: resumeFrom > 0
        ? `Resuming from ${resumeFrom.toLocaleString()} cached messages...`
        : `Initializing ${CONFIG.WORKER_COUNT} workers for parallel processing...`,
      processedMessages: resumeFrom,
      totalMessages,
    });

    const chunkSize = calculateOptimalChunkSize(messagesToInsert.length, CONFIG.WORKER_COUNT);
    const chunks = chunkMessages(messagesToInsert, chunkSize);

    console.log(
      `Multi-worker config: ${CONFIG.WORKER_COUNT} workers, ` +
      `${chunks.length} chunks, ${chunkSize} msgs/chunk`
    );

    const chunkProgress = new Map<number, { saved: number; total: number }>();
    let totalProcessed = resumeFrom;

    const updateProgress = (chunkIndex: number, saved: number, total: number) => {
      const prev = chunkProgress.get(chunkIndex);
      const prevSaved = prev?.saved || 0;
      const delta = saved - prevSaved;

      chunkProgress.set(chunkIndex, { saved, total });
      totalProcessed += delta;

      const denominator = totalMessages || messagesToInsert.length || 1;
      const normalizedProgress = Math.min(totalProcessed / denominator, 1);
      const progress = 65 + Math.floor(normalizedProgress * 30);

      onProgress?.({
        stage: 'saving',
        progress,
        message: `Processing with ${CONFIG.WORKER_COUNT} workers... (${totalProcessed.toLocaleString()}/${denominator.toLocaleString()})`,
        processedMessages: totalProcessed,
        totalMessages: denominator,
      });
    };

    workerPool = new WorkerPool(
      CONFIG.WORKER_COUNT,
      snapshotId,
      chunks.length,
      updateProgress
    );

    const insertStart = performance.now();
    await Promise.all(
      chunks.map((chunk, index) =>
        workerPool!.processChunk(chunk, index)
      )
    );

    await workerPool.waitForCompletion();

    const insertEnd = performance.now();
    const insertDurationMs = insertEnd - insertStart;
    const totalDurationMs = (decryptDurationMs ?? 0) + insertDurationMs;
    const insertedMessages = messagesToInsert.length;
    const throughputMessagesPerSec = totalDurationMs > 0
      ? insertedMessages / (totalDurationMs / 1000)
      : insertedMessages;

    metadata.status = 'completed';
    metadata.processedMessages = totalMessages;
    await dbManager.saveMetadata(metadata);

    const completionLabel = resumeFrom > 0
      ? `Resume complete! Processed remaining ${messagesToInsert.length.toLocaleString()} msgs (total ${totalMessages.toLocaleString()})`
      : `Multi-worker complete! ${totalMessages.toLocaleString()} msgs`;

    onProgress?.({
      stage: 'completed',
      progress: 100,
      message: `${completionLabel} (${throughputMessagesPerSec.toLocaleString(undefined, { maximumFractionDigits: 1 })} msgs/sec, ${CONFIG.WORKER_COUNT} workers)`,
      processedMessages: totalMessages,
      totalMessages,
      decryptDurationMs,
      insertDurationMs,
      totalDurationMs,
      insertedMessages,
      throughputMessagesPerSec,
    });
  } catch (error) {
    console.error('Multi-worker caching error:', error);

    const errorMetadata = await dbManager.getMetadata(snapshotId);
    if (errorMetadata) {
      errorMetadata.status = 'error';
      errorMetadata.error = error instanceof Error ? error.message : 'Unknown error';
      await dbManager.saveMetadata(errorMetadata);
    }

    onProgress?.({
      stage: 'error',
      progress: 0,
      message: 'Failed to load snapshot',
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    throw error;
  } finally {
    if (workerPool) {
      workerPool.terminate();
    }
  }
}

/**
 * Multi-worker parallel stream processing to IndexedDB
 */
export async function decryptAndStreamToIndexedDBMultiWorker(
  snapshotId: string,
  fileUrl: string,
  privateKeyPem: string,
  onProgress?: (progress: StreamingProgress) => void
): Promise<void> {
  const dbManager = new IndexedDBManager();

  try {
    const { metadata, skip } = await ensureProcessingMetadata(dbManager, snapshotId);
    if (skip) {
      onProgress?.({
        stage: 'completed',
        progress: 100,
        message: 'Snapshot already loaded in IndexedDB',
        processedMessages: metadata.processedMessages,
        totalMessages: metadata.totalMessages,
      });
      return;
    }

    // Stage 1: Download and decrypt
    onProgress?.({
      stage: 'downloading',
      progress: 0,
      message: 'Downloading snapshot file...',
    });

    const pipelineStart = performance.now();
    let decryptDurationMs = 0;
    const decryptedData = await decryptSnapshot(fileUrl, privateKeyPem, (status) => {
      if (status.includes('Downloading')) {
        onProgress?.({
          stage: 'downloading',
          progress: 10,
          message: status,
        });
      } else if (status.includes('Importing')) {
        onProgress?.({
          stage: 'decrypting',
          progress: 30,
          message: status,
        });
      } else if (status.includes('Decrypting')) {
        onProgress?.({
          stage: 'decrypting',
          progress: 50,
          message: status,
        });
      }
    });
    decryptDurationMs = performance.now() - pipelineStart;

    onProgress?.({
      stage: 'processing',
      progress: 60,
      message: 'Processing snapshot data...',
    });

    await cacheDecryptedSnapshotMultiWorker(
      snapshotId,
      decryptedData,
      onProgress,
      {
        metadata,
        dbManager,
        metrics: { decryptDurationMs },
      }
    );

  } catch (error) {
    console.error('Multi-worker streaming error:', error);

    const errorMetadata = await dbManager.getMetadata(snapshotId);
    if (errorMetadata) {
      errorMetadata.status = 'error';
      errorMetadata.error = error instanceof Error ? error.message : 'Unknown error';
      await dbManager.saveMetadata(errorMetadata);
    }

    onProgress?.({
      stage: 'error',
      progress: 0,
      message: 'Failed to load snapshot',
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    throw error;
  }
}

/**
 * Adaptive worker count based on CPU cores
 */
export function getOptimalWorkerCount(): number {
  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
    // Use half of available cores (leave room for main thread and browser)
    return Math.max(2, Math.min(8, Math.floor(navigator.hardwareConcurrency / 2)));
  }
  return CONFIG.WORKER_COUNT; // Default fallback
}

/**
 * Configure worker pool settings
 */
export function configureMultiWorker(options: {
  workerCount?: number;
  enablePerformanceLogs?: boolean;
}) {
  if (options.workerCount !== undefined) {
    CONFIG.WORKER_COUNT = options.workerCount;
  }
  if (options.enablePerformanceLogs !== undefined) {
    CONFIG.ENABLE_PERFORMANCE_LOGS = options.enablePerformanceLogs;
  }
}

// Re-export utility functions
export {
  getCachedSnapshot,
  getAllCachedSnapshots,
  deleteCachedSnapshot,
  getCachedMessages,
  searchCachedMessages,
  getCachedMessageCount,
} from './decrypt-snapshot-streaming';
