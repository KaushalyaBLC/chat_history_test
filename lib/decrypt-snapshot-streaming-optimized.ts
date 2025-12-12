/**
 * Advanced streaming snapshot decryption to IndexedDB
 * Uses concurrent batch processing and pipelining for optimal performance
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
}

// Configuration for optimal performance
const CONFIG = {
  // Batch sizes - larger batches for better throughput
  BATCH_SIZE_SMALL: 1000,    // < 5K messages
  BATCH_SIZE_MEDIUM: 2000,   // 5K-20K messages
  BATCH_SIZE_LARGE: 3000,    // 20K-50K messages
  BATCH_SIZE_XLARGE: 5000,   // > 50K messages

  // Concurrent processing - process multiple batches in parallel
  MAX_CONCURRENT_BATCHES: 3, // Process 3 batches simultaneously

  // Progress reporting
  PROGRESS_REPORT_INTERVAL: 100,

  // RAM management - release memory after processing
  ENABLE_MEMORY_RELEASE: true,
};

/**
 * Calculate optimal batch size based on total message count
 */
function calculateOptimalBatchSize(totalMessages: number): number {
  if (totalMessages < 5000) return CONFIG.BATCH_SIZE_SMALL;
  if (totalMessages < 20000) return CONFIG.BATCH_SIZE_MEDIUM;
  if (totalMessages < 50000) return CONFIG.BATCH_SIZE_LARGE;
  return CONFIG.BATCH_SIZE_XLARGE;
}

/**
 * Process a batch queue with controlled concurrency
 * This allows multiple batches to be written to IndexedDB simultaneously
 */
async function processBatchQueue<T>(
  items: T[],
  batchSize: number,
  maxConcurrent: number,
  processor: (batch: T[], batchIndex: number, totalBatches: number) => Promise<void>
): Promise<void> {
  const totalBatches = Math.ceil(items.length / batchSize);
  const batches: Array<{ items: T[]; index: number }> = [];

  // Create batch descriptors
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push({
      items: items.slice(i, Math.min(i + batchSize, items.length)),
      index: batches.length,
    });
  }

  // Process batches with controlled concurrency
  let activeIndex = 0;

  while (activeIndex < batches.length) {
    // Create a batch of promises (up to maxConcurrent)
    const concurrentBatches = batches
      .slice(activeIndex, activeIndex + maxConcurrent)
      .map(({ items, index }) =>
        processor(items, index, totalBatches)
      );

    // Wait for this batch of batches to complete
    await Promise.all(concurrentBatches);

    activeIndex += maxConcurrent;

    // Yield to event loop to keep UI responsive
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/**
 * Advanced decrypt and stream to IndexedDB with concurrent processing
 */
export async function decryptAndStreamToIndexedDBOptimized(
  snapshotId: string,
  fileUrl: string,
  privateKeyPem: string,
  onProgress?: (progress: StreamingProgress) => void
): Promise<void> {
  const dbManager = new IndexedDBManager();

  try {
    // Check if snapshot already exists
    const existingMetadata = await dbManager.getMetadata(snapshotId);
    if (existingMetadata && existingMetadata.status === 'completed') {
      onProgress?.({
        stage: 'completed',
        progress: 100,
        message: 'Snapshot already loaded in IndexedDB',
        processedMessages: existingMetadata.processedMessages,
        totalMessages: existingMetadata.totalMessages,
      });
      return;
    }

    // Create initial metadata
    const metadata: SnapshotMetadata = {
      snapshotId,
      messageCount: 0,
      processedMessages: 0,
      createdAt: new Date().toISOString(),
      status: 'processing',
    };
    await dbManager.saveMetadata(metadata);

    // Stage 1: Download and decrypt
    onProgress?.({
      stage: 'downloading',
      progress: 0,
      message: 'Downloading snapshot file...',
    });

    const perfStart = performance.now();
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

    onProgress?.({
      stage: 'processing',
      progress: 60,
      message: 'Processing snapshot data...',
    });

    // Extract snapshot info
    const { projectId, queueId, messageCount, messages } = decryptedData;

    if (!messages || !Array.isArray(messages)) {
      throw new Error('Invalid snapshot format: missing messages array');
    }

    // Update metadata with snapshot info
    metadata.projectId = projectId;
    metadata.queueId = queueId;
    metadata.messageCount = messageCount || messages.length;
    metadata.totalMessages = messages.length;

    if (messages.length > 0) {
      metadata.firstMessageDate = messages[0].created_at;
      metadata.lastMessageDate = messages[messages.length - 1].created_at;
    }

    await dbManager.saveMetadata(metadata);

    // Stage 2: Concurrent batch processing for faster saves
    onProgress?.({
      stage: 'saving',
      progress: 65,
      message: 'Saving messages to IndexedDB with concurrent processing...',
      processedMessages: 0,
      totalMessages: messages.length,
    });

    const batchSize = calculateOptimalBatchSize(messages.length);
    const totalBatches = Math.ceil(messages.length / batchSize);
    let processedCount = 0;

    // Progress tracking
    const updateProgress = (batchIndex: number, savedInBatch: number) => {
      processedCount += savedInBatch;
      const progress = 65 + Math.floor((processedCount / messages.length) * 30);

      onProgress?.({
        stage: 'saving',
        progress,
        message: `Saving batches concurrently... (${processedCount.toLocaleString()}/${messages.length.toLocaleString()})`,
        processedMessages: processedCount,
        totalMessages: messages.length,
      });
    };

    // Process batches with concurrency
    await processBatchQueue(
      messages,
      batchSize,
      CONFIG.MAX_CONCURRENT_BATCHES,
      async (batch, batchIndex, totalBatches) => {
        const batchStart = batchIndex * batchSize;

        await dbManager.saveMessagesBatch(snapshotId, batch, (saved) => {
          // Only update progress at intervals to reduce overhead
          if (saved % CONFIG.PROGRESS_REPORT_INTERVAL === 0 || saved === batch.length) {
            updateProgress(batchIndex, saved);
          }
        });

        // Release memory if enabled (helps with large snapshots)
        if (CONFIG.ENABLE_MEMORY_RELEASE && batchIndex % 5 === 0) {
          // Hint to garbage collector for older batches
          batch.length = 0;
        }
      }
    );

    const perfEnd = performance.now();
    const durationSec = ((perfEnd - perfStart) / 1000).toFixed(2);
    const throughput = Math.floor(messages.length / (perfEnd - perfStart) * 1000);

    // Mark as completed
    metadata.status = 'completed';
    metadata.processedMessages = messages.length;
    await dbManager.saveMetadata(metadata);

    onProgress?.({
      stage: 'completed',
      progress: 100,
      message: `Snapshot loaded! (${messages.length.toLocaleString()} msgs in ${durationSec}s, ${throughput.toLocaleString()} msgs/sec)`,
      processedMessages: messages.length,
      totalMessages: messages.length,
    });

  } catch (error) {
    console.error('Streaming decryption error:', error);

    // Update metadata with error
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
 * Memory-optimized version with aggressive garbage collection hints
 * Use this for very large snapshots (>100K messages)
 */
export async function decryptAndStreamToIndexedDBMemoryOptimized(
  snapshotId: string,
  fileUrl: string,
  privateKeyPem: string,
  onProgress?: (progress: StreamingProgress) => void
): Promise<void> {
  // Temporarily override config for memory-constrained scenarios
  const originalBatchSize = CONFIG.BATCH_SIZE_LARGE;
  const originalConcurrency = CONFIG.MAX_CONCURRENT_BATCHES;

  CONFIG.BATCH_SIZE_LARGE = 1500;  // Smaller batches
  CONFIG.MAX_CONCURRENT_BATCHES = 2; // Less concurrency
  CONFIG.ENABLE_MEMORY_RELEASE = true;

  try {
    await decryptAndStreamToIndexedDBOptimized(snapshotId, fileUrl, privateKeyPem, onProgress);
  } finally {
    // Restore original config
    CONFIG.BATCH_SIZE_LARGE = originalBatchSize;
    CONFIG.MAX_CONCURRENT_BATCHES = originalConcurrency;
  }
}

// Re-export original functions for backward compatibility
export {
  getCachedSnapshot,
  getAllCachedSnapshots,
  deleteCachedSnapshot,
  getCachedMessages,
  searchCachedMessages,
  getCachedMessageCount,
} from './decrypt-snapshot-streaming';
