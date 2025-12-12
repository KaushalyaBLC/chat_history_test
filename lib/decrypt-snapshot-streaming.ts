/**
 * Streaming snapshot decryption to IndexedDB
 * Processes large snapshots without loading everything into RAM
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

// Dynamic batch sizing based on total message count for optimal RAM buffering
const BATCH_SIZE_SMALL = 500;   // < 1K messages
const BATCH_SIZE_MEDIUM = 1000; // 1K-10K messages
const BATCH_SIZE_LARGE = 2000;  // 10K-50K messages (recommended for 36K snapshots)
const BATCH_SIZE_XLARGE = 3000; // > 50K messages

/**
 * Calculate optimal batch size based on total message count
 * Larger batches reduce transaction overhead and improve performance
 */
function calculateOptimalBatchSize(totalMessages: number): number {
  if (totalMessages < 1000) return BATCH_SIZE_SMALL;
  if (totalMessages < 10000) return BATCH_SIZE_MEDIUM;
  if (totalMessages < 50000) return BATCH_SIZE_LARGE;
  return BATCH_SIZE_XLARGE;
}

/**
 * Decrypt and stream snapshot to IndexedDB
 */
export async function decryptAndStreamToIndexedDB(
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

    // Stage 2: Save messages in batches with optimized RAM buffering
    onProgress?.({
      stage: 'saving',
      progress: 65,
      message: 'Saving messages to IndexedDB...',
      processedMessages: 0,
      totalMessages: messages.length,
    });

    let processedCount = 0;
    const batchSize = calculateOptimalBatchSize(messages.length);
    const totalBatches = Math.ceil(messages.length / batchSize);

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const start = batchIndex * batchSize;
      const end = Math.min(start + batchSize, messages.length);
      const batch = messages.slice(start, end);

      await dbManager.saveMessagesBatch(snapshotId, batch, (saved) => {
        processedCount = start + saved;
        const progress = 65 + Math.floor((processedCount / messages.length) * 30);

        onProgress?.({
          stage: 'saving',
          progress,
          message: `Saving batch ${batchIndex + 1}/${totalBatches}... (${processedCount}/${messages.length})`,
          processedMessages: processedCount,
          totalMessages: messages.length,
        });
      });

      // Allow UI to update between batches
      if (batchIndex < totalBatches - 1) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    // Mark as completed
    metadata.status = 'completed';
    metadata.processedMessages = messages.length;
    await dbManager.saveMetadata(metadata);

    onProgress?.({
      stage: 'completed',
      progress: 100,
      message: 'Snapshot loaded successfully!',
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
 * Get cached snapshot metadata
 */
export async function getCachedSnapshot(snapshotId: string): Promise<SnapshotMetadata | null> {
  const dbManager = new IndexedDBManager();
  return dbManager.getMetadata(snapshotId);
}

/**
 * Get all cached snapshots
 */
export async function getAllCachedSnapshots(): Promise<SnapshotMetadata[]> {
  const dbManager = new IndexedDBManager();
  return dbManager.getAllMetadata();
}

/**
 * Delete cached snapshot
 */
export async function deleteCachedSnapshot(snapshotId: string): Promise<void> {
  const dbManager = new IndexedDBManager();
  return dbManager.deleteSnapshot(snapshotId);
}

/**
 * Get messages from cached snapshot
 */
export async function getCachedMessages(
  snapshotId: string,
  options: { offset?: number; limit?: number } = {}
): Promise<Message[]> {
  const dbManager = new IndexedDBManager();
  return dbManager.getMessages(snapshotId, options);
}

/**
 * Search messages in cached snapshot
 */
export async function searchCachedMessages(
  snapshotId: string,
  searchText: string,
  limit?: number
): Promise<Message[]> {
  const dbManager = new IndexedDBManager();
  return dbManager.searchMessages(snapshotId, searchText, limit);
}

/**
 * Get total message count
 */
export async function getCachedMessageCount(snapshotId: string): Promise<number> {
  const dbManager = new IndexedDBManager();
  return dbManager.getMessageCount(snapshotId);
}
