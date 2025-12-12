/**
 * Web Worker for parallel IndexedDB message processing
 * Each worker handles a chunk of messages independently
 */

import { IndexedDBManager, type Message } from '../indexeddb-manager';

export interface WorkerTask {
  type: 'SAVE_BATCH';
  snapshotId: string;
  messages: Message[];
  chunkIndex: number;
  totalChunks: number;
}

export interface WorkerProgress {
  type: 'PROGRESS';
  chunkIndex: number;
  saved: number;
  total: number;
}

export interface WorkerComplete {
  type: 'COMPLETE';
  chunkIndex: number;
  saved: number;
  duration: number;
}

export interface WorkerError {
  type: 'ERROR';
  chunkIndex: number;
  error: string;
}

type WorkerMessage = WorkerTask;
type WorkerResponse = WorkerProgress | WorkerComplete | WorkerError;

// Worker message handler
self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { type, snapshotId, messages, chunkIndex, totalChunks } = e.data;

  if (type === 'SAVE_BATCH') {
    const startTime = performance.now();

    try {
      const dbManager = new IndexedDBManager();
      let savedCount = 0;

      // Save messages with progress reporting
      await dbManager.saveMessagesBatch(snapshotId, messages, (saved) => {
        savedCount = saved;

        // Report progress every 100 messages
        if (saved % 100 === 0 || saved === messages.length) {
          const progress: WorkerProgress = {
            type: 'PROGRESS',
            chunkIndex,
            saved,
            total: messages.length,
          };
          self.postMessage(progress);
        }
      });

      const endTime = performance.now();
      const duration = endTime - startTime;

      // Report completion
      const complete: WorkerComplete = {
        type: 'COMPLETE',
        chunkIndex,
        saved: savedCount,
        duration,
      };
      self.postMessage(complete);

    } catch (error) {
      const errorResponse: WorkerError = {
        type: 'ERROR',
        chunkIndex,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      self.postMessage(errorResponse);
    }
  }
};

// Export types for TypeScript
export type { WorkerMessage, WorkerResponse };
