'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { decryptSnapshot } from '@/lib/decrypt-snapshot';
import {
  cacheDecryptedSnapshotMultiWorker,
  configureMultiWorker,
  getOptimalWorkerCount,
} from '@/lib/decrypt-snapshot-streaming-multiworker';
import type { StreamingProgress } from '@/lib/decrypt-snapshot-streaming';
import { IndexedDBManager } from '@/lib/indexeddb-manager';
import {
  saveStagedSnapshot,
  loadStagedSnapshot,
  deleteStagedSnapshot,
  clearAllStagedSnapshots,
} from '@/lib/staged-snapshot-store';

interface Snapshot {
  id: string;
  message_count: number;
  file_size: string;
  status: string;
  first_message_date: string;
  last_message_date: string;
}

interface SnapshotsResponse {
  success: boolean;
  message: string;
  data: {
    items: Snapshot[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      hasMore: boolean;
    };
  };
}

interface SnapshotDetail extends Snapshot {
  snapshot_private_key?: string;
  file_url?: string;
}

type BulkStatusState = 'queued' | 'fetching' | 'skipped' | 'processing' | 'completed' | 'error';

interface BulkSnapshotStatus {
  snapshotId: string;
  label: string;
  status: BulkStatusState;
  message: string;
  progress: number;
  stage?: string;
  processedMessages?: number;
  totalMessages?: number;
  error?: string;
  decryptDurationMs?: number;
  insertDurationMs?: number;
  totalDurationMs?: number;
  insertedMessages?: number;
  throughputPerSecond?: number;
}

const BULK_FETCH_LIMIT = 50;
const PREFETCH_SIZE_LIMIT_MB = 25;

export default function Home() {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({
    total: 0,
    hasMore: false,
  });
  const [projectSlug, setProjectSlug] = useState<string | null>(null);
  const [slugInput, setSlugInput] = useState('');
  const [slugPromptError, setSlugPromptError] = useState<string | null>(null);
  const [isBulkLoading, setIsBulkLoading] = useState(false);
  const [bulkStatuses, setBulkStatuses] = useState<BulkSnapshotStatus[]>([]);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkStartedAt, setBulkStartedAt] = useState<number | null>(null);
  const [bulkEndedAt, setBulkEndedAt] = useState<number | null>(null);
  const [isClearingIndexedDB, setIsClearingIndexedDB] = useState(false);
  const autoWorkerCount = useMemo(() => getOptimalWorkerCount(), []);
  const bulkCompletedCount = useMemo(
    () => bulkStatuses.filter(status => status.status === 'completed').length,
    [bulkStatuses]
  );
  const bulkSkippedCount = useMemo(
    () => bulkStatuses.filter(status => status.status === 'skipped').length,
    [bulkStatuses]
  );
  const bulkErrorCount = useMemo(
    () => bulkStatuses.filter(status => status.status === 'error').length,
    [bulkStatuses]
  );
  const bulkSummary = useMemo(() => {
    const insertedTotal = bulkStatuses.reduce(
      (sum, status) => sum + (status.insertedMessages ?? 0),
      0
    );
    const completedSnapshots = bulkStatuses.filter(status => status.status === 'completed').length;
    const totalDurationMs =
      bulkStartedAt && bulkEndedAt ? Math.max(0, bulkEndedAt - bulkStartedAt) : null;
    const throughput =
      totalDurationMs && totalDurationMs > 0
        ? insertedTotal / (totalDurationMs / 1000)
        : null;
    return {
      insertedTotal,
      totalDurationMs,
      throughput,
      completedSnapshots,
    };
  }, [bulkStatuses, bulkStartedAt, bulkEndedAt]);

  useEffect(() => {
    try {
      const storedSlug = localStorage.getItem('projectSlug');
      if (storedSlug) {
        setProjectSlug(storedSlug);
        setSlugInput(storedSlug);
      }
    } catch (storageError) {
      console.error('Failed to read project slug from storage', storageError);
    }
  }, []);

  useEffect(() => {
    if (!projectSlug) return;
    fetchSnapshots(page, projectSlug);
  }, [page, projectSlug]);

  const handleProjectSlugSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedSlug = slugInput.trim();
    if (!normalizedSlug) {
      setSlugPromptError('Project slug is required');
      return;
    }
    setSlugPromptError(null);
    setSlugInput(normalizedSlug);
    setProjectSlug(normalizedSlug);
    setSnapshots([]);
    setPagination({ total: 0, hasMore: false });
    setPage(1);
    setError(null);
    setBulkStatuses([]);
    setBulkMessage(null);
    setBulkError(null);
    try {
      localStorage.setItem('projectSlug', normalizedSlug);
    } catch (storageError) {
      console.error('Failed to store project slug', storageError);
    }
  };

  const handleClearProjectSlug = () => {
    setSlugInput(projectSlug ?? '');
    setProjectSlug(null);
    setSnapshots([]);
    setPagination({ total: 0, hasMore: false });
    setPage(1);
    setError(null);
    setBulkStatuses([]);
    setBulkMessage(null);
    setBulkError(null);
    setBulkStartedAt(null);
    setBulkEndedAt(null);
    try {
      localStorage.removeItem('projectSlug');
    } catch (storageError) {
      console.error('Failed to clear project slug', storageError);
    }
  };

  const handleClearIndexedDB = async () => {
    if (isClearingIndexedDB) return;
    if (
      !window.confirm(
        'Clear all cached snapshot data stored in IndexedDB on this device? This cannot be undone.'
      )
    ) {
      return;
    }

    try {
      setIsClearingIndexedDB(true);
      const manager = new IndexedDBManager();
      await manager.clearAll();
      setBulkStatuses([]);
      setBulkMessage(null);
      setBulkError(null);
      setBulkStartedAt(null);
      setBulkEndedAt(null);
      alert('IndexedDB cache cleared. Reload snapshots to re-cache data.');
    } catch (error) {
      console.error('Failed to clear IndexedDB cache', error);
      alert('Failed to clear IndexedDB cache. Check the console for details.');
    } finally {
      setIsClearingIndexedDB(false);
    }
  };

  const fetchSnapshots = async (pageNum: number, slug: string) => {
    try {
      if (!slug) {
        setError('Project slug is required');
        return;
      }
      setLoading(true);
      setError(null);
      const response = await fetch(
        `/api/snapshots?page=${pageNum}&limit=20&projectSlug=${encodeURIComponent(slug)}`
      );

      if (!response.ok) {
        throw new Error('Failed to fetch snapshots');
      }

      const data: SnapshotsResponse = await response.json();

      if (data.success) {
        setSnapshots(data.data.items);
        setPagination({
          total: data.data.pagination.total,
          hasMore: data.data.pagination.hasMore,
        });
      } else {
        setError(data.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const fetchAllSnapshotsList = async (slug: string): Promise<Snapshot[]> => {
    if (!slug) {
      throw new Error('Project slug is required');
    }
    const aggregated: Snapshot[] = [];
    let currentPage = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await fetch(
        `/api/snapshots?page=${currentPage}&limit=${BULK_FETCH_LIMIT}&projectSlug=${encodeURIComponent(slug)}`
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch snapshots (page ${currentPage})`);
      }

      const data: SnapshotsResponse = await response.json();
      if (!data.success) {
        throw new Error(data.message || 'Failed to fetch snapshots');
      }

      aggregated.push(...data.data.items);
      hasMore = data.data.pagination.hasMore;
      currentPage += 1;
    }

    return aggregated;
  };

  const fetchSnapshotDetail = async (snapshotId: string, slug: string): Promise<SnapshotDetail | null> => {
    if (!slug) {
      throw new Error('Project slug is required');
    }
    const response = await fetch(
      `/api/snapshots/${snapshotId}?projectSlug=${encodeURIComponent(slug)}`
    );
    if (!response.ok) {
      throw new Error('Failed to fetch snapshot details');
    }

    const data = await response.json();
    if (data.success === false) {
      throw new Error(data.message || 'Failed to fetch snapshot details');
    }

    return data.data as SnapshotDetail;
  };

  const updateBulkStatus = (snapshotId: string, updates: Partial<BulkSnapshotStatus>) => {
    const sanitized: Partial<BulkSnapshotStatus> = { ...updates };
    ([
      'decryptDurationMs',
      'insertDurationMs',
      'totalDurationMs',
      'insertedMessages',
      'throughputPerSecond',
    ] as (keyof BulkSnapshotStatus)[]).forEach((key) => {
      if (sanitized[key] === undefined) {
        delete sanitized[key];
      }
    });
    setBulkStatuses(prev =>
      prev.map(status =>
        status.snapshotId === snapshotId
          ? { ...status, ...sanitized }
          : status
      )
    );
  };

  const stageSnapshotToStorage = async (snapshot: Snapshot, slug: string): Promise<boolean> => {
    try {
      updateBulkStatus(snapshot.id, {
        status: 'fetching',
        message: 'Fetching snapshot metadata...',
        progress: 0,
        stage: 'fetching',
      });

      const detail = await fetchSnapshotDetail(snapshot.id, slug);

      if (!detail?.snapshot_private_key || !detail?.file_url) {
        updateBulkStatus(snapshot.id, {
          status: 'skipped',
          message: 'Missing file URL or private key',
          progress: 100,
          stage: 'skipped',
        });
        return false;
      }

      updateBulkStatus(snapshot.id, {
        status: 'processing',
        message: 'Downloading snapshot...',
        stage: 'downloading',
      });

      const response = await fetch(detail.file_url);
      if (!response.ok) {
        throw new Error(`Failed to download snapshot file (${response.status})`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const sizeMb = arrayBuffer.byteLength / (1024 * 1024);

      updateBulkStatus(snapshot.id, {
        status: 'processing',
        message: 'Decrypting snapshot...',
        stage: 'decrypting',
      });

      const decryptStart = performance.now();
      const decryptedData = await decryptSnapshot(
        arrayBuffer,
        detail.snapshot_private_key,
        (status) => {
          updateBulkStatus(snapshot.id, {
            status: 'processing',
            message: status,
            stage: status.includes('Decrypting') ? 'decrypting' : status.includes('Importing') ? 'decrypting' : 'downloading',
          });
        }
      );
      const decryptDurationMs = performance.now() - decryptStart;

      await saveStagedSnapshot({
        snapshotId: snapshot.id,
        decryptedData,
        decryptDurationMs,
        approxSizeMb: sizeMb,
        createdAt: new Date().toISOString(),
      });

      updateBulkStatus(snapshot.id, {
        status: 'processing',
        message: `Staged decrypted snapshot (${sizeMb.toFixed(2)} MB)`,
        stage: 'staged',
        progress: 70,
        decryptDurationMs,
      });
      return true;
    } catch (error) {
      console.error('Staging failed', error);
      updateBulkStatus(snapshot.id, {
        status: 'error',
        message: 'Failed while staging snapshot',
        error: error instanceof Error ? error.message : 'Unknown error',
        progress: 100,
        stage: 'error',
      });
      return false;
    }
  };

  const handleBulkLoadAll = async () => {
    if (isBulkLoading) return;
    if (!projectSlug) {
      setBulkError('Please set a project slug before loading snapshots.');
      return;
    }
    const activeSlug = projectSlug;

    setBulkError(null);
    setBulkMessage(null);
    const runStart = performance.now();
    setBulkStartedAt(runStart);
    setBulkEndedAt(null);

    try {
      setIsBulkLoading(true);
      await clearAllStagedSnapshots().catch((error) => {
        console.error('Failed to clear staged snapshots', error);
      });
      configureMultiWorker({
        workerCount: autoWorkerCount,
        enablePerformanceLogs: false,
      });

      const allSnapshots = await fetchAllSnapshotsList(activeSlug);

      if (allSnapshots.length === 0) {
        setBulkStatuses([]);
        setBulkMessage('No snapshots available to load.');
        return;
      }

      const initialStatuses: BulkSnapshotStatus[] = allSnapshots.map(snapshot => ({
        snapshotId: snapshot.id,
        label: `${snapshot.id.substring(0, 8)} • ${new Date(snapshot.first_message_date).toLocaleDateString()}`,
        status: 'queued',
        message: 'Queued',
        progress: 0,
      }));

      setBulkStatuses(initialStatuses);

      const totalSnapshots = allSnapshots.length;
      const stagedSnapshotQueue: string[] = [];
      const waitingResolvers: Array<() => void> = [];
      let nextToSchedule = 0;
      let inFlightMb = 0;
      const activePreparations = new Map<string, number>();

      const notifyPrepared = () => {
        while (
          waitingResolvers.length &&
          (stagedSnapshotQueue.length > 0 ||
            (nextToSchedule >= totalSnapshots && activePreparations.size === 0))
        ) {
          waitingResolvers.shift()?.();
        }
      };

      const startPreparation = (snapshot: Snapshot, sizeMb: number) => {
        inFlightMb += sizeMb;
        activePreparations.set(snapshot.id, sizeMb);
        stageSnapshotToStorage(snapshot, activeSlug)
          .then((success) => {
            if (success) {
              stagedSnapshotQueue.push(snapshot.id);
            }
          })
          .finally(() => {
            inFlightMb -= sizeMb;
            activePreparations.delete(snapshot.id);
            schedulePrefetch();
            notifyPrepared();
          });
      };

      const schedulePrefetch = () => {
        let startedAny = false;
        while (nextToSchedule < totalSnapshots) {
          const snapshot = allSnapshots[nextToSchedule];
          const sizeMb = parseFileSizeMb(snapshot.file_size);
          const canStart =
            inFlightMb + sizeMb <= PREFETCH_SIZE_LIMIT_MB ||
            activePreparations.size === 0;
          if (!canStart) break;
          startPreparation(snapshot, sizeMb);
          nextToSchedule++;
          startedAny = true;
        }
        return startedAny;
      };

      const getNextStagedSnapshotId = async (): Promise<string | null> => {
        if (stagedSnapshotQueue.length > 0) {
          return stagedSnapshotQueue.shift()!;
        }
        if (nextToSchedule >= totalSnapshots && activePreparations.size === 0) {
          return null;
        }
        await new Promise<void>((resolve) => waitingResolvers.push(resolve));
        return getNextStagedSnapshotId();
      };

      schedulePrefetch();

      while (true) {
        const stagedSnapshotId = await getNextStagedSnapshotId();
        if (!stagedSnapshotId) break;

        const stagedRecord = await loadStagedSnapshot(stagedSnapshotId);
        if (!stagedRecord) {
          updateBulkStatus(stagedSnapshotId, {
            status: 'error',
            message: 'Staged snapshot missing from storage',
            progress: 100,
            stage: 'error',
          });
          continue;
        }

        updateBulkStatus(stagedSnapshotId, {
          status: 'processing',
          message: 'Loading staged snapshot...',
          stage: 'processing',
        });

        try {
          await cacheDecryptedSnapshotMultiWorker(
            stagedSnapshotId,
            stagedRecord.decryptedData,
            (progress: StreamingProgress) => {
              const statusUpdate: Partial<BulkSnapshotStatus> = {
                status:
                  progress.stage === 'completed'
                    ? 'completed'
                    : progress.stage === 'error'
                      ? 'error'
                      : 'processing',
                message: progress.message,
                progress: progress.progress,
                stage: progress.stage,
                processedMessages: progress.processedMessages,
                totalMessages: progress.totalMessages,
              };
              if (progress.decryptDurationMs !== undefined) {
                statusUpdate.decryptDurationMs = progress.decryptDurationMs;
              }
              if (progress.insertDurationMs !== undefined) {
                statusUpdate.insertDurationMs = progress.insertDurationMs;
              }
              if (progress.totalDurationMs !== undefined) {
                statusUpdate.totalDurationMs = progress.totalDurationMs;
              }
              if (progress.insertedMessages !== undefined) {
                statusUpdate.insertedMessages = progress.insertedMessages;
              }
              if (progress.throughputMessagesPerSec !== undefined) {
                statusUpdate.throughputPerSecond = progress.throughputMessagesPerSec;
              }
              updateBulkStatus(stagedSnapshotId, statusUpdate);
            },
            {
              metrics: { decryptDurationMs: stagedRecord.decryptDurationMs },
            }
          );

          updateBulkStatus(stagedSnapshotId, {
            message: 'Snapshot cached successfully',
          });
        } catch (snapshotError) {
          console.error('Bulk snapshot load failed', snapshotError);
          updateBulkStatus(stagedSnapshotId, {
            status: 'error',
            message: 'Failed to cache snapshot',
            error: snapshotError instanceof Error ? snapshotError.message : 'Unknown error',
            progress: 100,
            stage: 'error',
          });
        } finally {
          await deleteStagedSnapshot(stagedSnapshotId).catch((error) =>
            console.error('Failed to delete staged snapshot', error)
          );
        }
      }

      setBulkMessage('Bulk snapshot loading complete.');
    } catch (bulkError) {
      console.error('Bulk load failed', bulkError);
      setBulkError(bulkError instanceof Error ? bulkError.message : 'Unknown error');
    } finally {
      setIsBulkLoading(false);
      setBulkEndedAt(performance.now());
      await clearAllStagedSnapshots().catch((error) =>
        console.error('Failed to clear staged snapshots after run', error)
      );
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatDurationMs = (ms?: number | null) => {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
      return '—';
    }
    if (ms >= 60_000) {
      const minutes = Math.floor(ms / 60_000);
      const seconds = Math.round((ms % 60_000) / 1000);
      return `${minutes}m ${seconds}s`;
    }
    if (ms >= 1000) {
      return `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)}s`;
    }
    return `${Math.round(ms)}ms`;
  };

  const formatThroughput = (value?: number | null) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return '—';
    }
    if (value >= 1000) {
      return `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} msg/s`;
    }
    return `${value.toFixed(1)} msg/s`;
  };
  const parseFileSizeMb = (fileSize?: string): number => {
    if (!fileSize) return 5;
    const match = fileSize.match(/([\d.]+)\s*(kb|mb|gb|b)/i);
    if (!match) {
      const numeric = Number(fileSize);
      if (Number.isFinite(numeric) && numeric > 0) {
        return numeric;
      }
      return 5;
    }
    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (!Number.isFinite(value)) return 5;
    switch (unit) {
      case 'gb':
        return value * 1024;
      case 'mb':
        return value;
      case 'kb':
        return value / 1024;
      case 'b':
        return value / (1024 * 1024);
      default:
        return value;
    }
  };

  if (!projectSlug) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center px-4">
        <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-xl p-8">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Enter Project Slug</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
            Provide the Olee project slug to load available message history snapshots.
          </p>
          <form onSubmit={handleProjectSlugSubmit} className="mt-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                Project Slug
              </label>
              <input
                type="text"
                value={slugInput}
                onChange={(event) => setSlugInput(event.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="e.g. fintra"
                autoFocus
              />
              {slugPromptError && (
                <p className="mt-2 text-sm text-red-600 dark:text-red-400">{slugPromptError}</p>
              )}
            </div>
            <button
              type="submit"
              className="w-full rounded-lg bg-blue-600 text-white py-2.5 font-semibold hover:bg-blue-700 transition-colors"
            >
              Continue
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (loading && snapshots.length === 0) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-slate-600 dark:text-slate-400">Loading snapshots...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6 max-w-md">
          <h2 className="text-red-800 dark:text-red-400 text-lg font-semibold mb-2">Error</h2>
          <p className="text-red-600 dark:text-red-300">{error}</p>
          <button
            onClick={() => projectSlug && fetchSnapshots(page, projectSlug)}
            disabled={!projectSlug}
            className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900 dark:text-white mb-2">
              Message History Snapshots
            </h1>
            <p className="text-slate-600 dark:text-slate-400">
              Total snapshots: {pagination.total}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-600 dark:text-slate-400">
              <span>
                Project slug:{' '}
                <span className="font-mono text-slate-900 dark:text-slate-100">{projectSlug}</span>
              </span>
              <button
                type="button"
                onClick={handleClearProjectSlug}
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                Change project slug
              </button>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 md:min-w-max">
            <button
              onClick={handleBulkLoadAll}
              disabled={isBulkLoading}
              className="inline-flex w-full items-center justify-center gap-2 px-5 py-3 rounded-lg bg-purple-600 text-white font-semibold shadow-lg shadow-purple-600/30 hover:bg-purple-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed sm:w-auto"
            >
              {isBulkLoading ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Loading all snapshots...
                </>
              ) : (
                <>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h10m-5 4h5M5 8h.01M5 12h.01M5 16h.01" />
                  </svg>
                  Load all snapshots to IndexedDB
                </>
              )}
            </button>
            <button
              onClick={handleClearIndexedDB}
              disabled={isClearingIndexedDB}
              className="inline-flex w-full items-center justify-center gap-2 px-5 py-3 rounded-lg bg-red-600 text-white font-semibold shadow-lg shadow-red-600/30 hover:bg-red-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed sm:w-auto"
            >
              {isClearingIndexedDB ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Clearing cache...
                </>
              ) : (
                <>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-1 12a2 2 0 01-2 2H8a2 2 0 01-2-2L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
                  </svg>
                  Clear IndexedDB cache
                </>
              )}
            </button>
          </div>
        </div>

        {(bulkStatuses.length > 0 || isBulkLoading || bulkMessage || bulkError) && (
          <div className="mb-8 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl p-6 shadow-lg">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-xl font-semibold text-slate-900 dark:text-white">
                  Bulk Snapshot Loader
                </h2>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Using {autoWorkerCount} worker{autoWorkerCount !== 1 ? 's' : ''} • {bulkStatuses.length} snapshot{bulkStatuses.length !== 1 ? 's' : ''}
                </p>
              </div>
              <div className="flex flex-wrap gap-4 text-sm">
                <span className="text-green-600 dark:text-green-400">
                  Completed: {bulkCompletedCount}
                </span>
                <span className="text-amber-600 dark:text-amber-400">
                  Skipped: {bulkSkippedCount}
                </span>
                <span className="text-red-600 dark:text-red-400">
                  Errors: {bulkErrorCount}
                </span>
              </div>
            </div>
            {(bulkStartedAt || bulkSummary.insertedTotal > 0) && (
              <div className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                Overall inserted {bulkSummary.insertedTotal.toLocaleString()} msg
                {bulkSummary.insertedTotal === 1 ? '' : 's'}
                {bulkSummary.totalDurationMs !== null &&
                  ` in ${formatDurationMs(bulkSummary.totalDurationMs)}`}
                {bulkSummary.throughput &&
                  ` • ${formatThroughput(bulkSummary.throughput)}`}
              </div>
            )}

            {bulkError && (
              <div className="mt-4 text-sm text-red-700 dark:text-red-300 bg-red-100 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-2">
                {bulkError}
              </div>
            )}

            {bulkMessage && (
              <div className="mt-4 text-sm text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-2">
                {bulkMessage}
              </div>
            )}

            <div className="mt-4 space-y-3 max-h-80 overflow-y-auto pr-1">
              {bulkStatuses.map(status => {
                const statusColors = {
                  completed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
                  processing: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
                  fetching: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
                  queued: 'bg-slate-100 text-slate-700 dark:bg-slate-900/40 dark:text-slate-300',
                  skipped: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
                  error: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
                } as const;
                const badgeClass = statusColors[status.status] || statusColors.queued;

                return (
                  <div
                    key={status.snapshotId}
                    className="border border-slate-200 dark:border-slate-700 rounded-lg p-4 bg-slate-50/50 dark:bg-slate-900/40"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${badgeClass}`}>
                          {status.status.charAt(0).toUpperCase() + status.status.slice(1)}
                        </span>
                        <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
                          {status.label}
                        </span>
                      </div>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        {status.progress}% {status.stage && `• ${status.stage}`}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                      {status.message}
                    </p>
                    {status.processedMessages !== undefined && status.totalMessages !== undefined && (
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                        {status.processedMessages.toLocaleString()} / {status.totalMessages.toLocaleString()} messages
                      </p>
                    )}
                    <div className="mt-2 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          status.status === 'completed'
                            ? 'bg-green-500'
                            : status.status === 'error'
                              ? 'bg-red-500'
                              : 'bg-blue-500'
                        }`}
                        style={{ width: `${status.progress}%` }}
                      ></div>
                    </div>
                    {(status.totalDurationMs !== undefined ||
                      status.insertedMessages !== undefined ||
                      status.throughputPerSecond !== undefined) && (
                      <div className="mt-2 text-[11px] text-slate-600 dark:text-slate-400 flex flex-wrap gap-3">
                        {status.totalDurationMs !== undefined && (
                          <span>Duration: {formatDurationMs(status.totalDurationMs)}</span>
                        )}
                        {status.insertedMessages !== undefined && (
                          <span>
                            Inserted: {status.insertedMessages.toLocaleString()} msg
                            {status.insertedMessages === 1 ? '' : 's'}
                          </span>
                        )}
                        {status.throughputPerSecond !== undefined && (
                          <span>Throughput: {formatThroughput(status.throughputPerSecond)}</span>
                        )}
                      </div>
                    )}
                    {status.error && (
                      <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                        {status.error}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Snapshots Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {snapshots.map((snapshot) => (
            <Link
              key={snapshot.id}
              href={`/snapshots/${snapshot.id}`}
              className="block bg-white dark:bg-slate-800 rounded-xl shadow-md hover:shadow-xl transition-all duration-300 overflow-hidden border border-slate-200 dark:border-slate-700 hover:scale-105"
            >
              <div className="p-6">
                {/* Status Badge */}
                <div className="flex items-center justify-between mb-4">
                  <span
                    className={`px-3 py-1 rounded-full text-xs font-semibold ${
                      snapshot.status === 'completed'
                        ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                        : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400'
                    }`}
                  >
                    {snapshot.status}
                  </span>
                  <span className="text-sm font-medium text-slate-500 dark:text-slate-400">
                    {snapshot.file_size}
                  </span>
                </div>

                {/* Message Count */}
                <div className="mb-4">
                  <div className="text-3xl font-bold text-blue-600 dark:text-blue-400">
                    {snapshot?.message_count.toLocaleString()}
                  </div>
                  <div className="text-sm text-slate-500 dark:text-slate-400">
                    messages
                  </div>
                </div>

                {/* Date Range */}
                <div className="space-y-2 text-sm">
                  <div>
                    <span className="text-slate-500 dark:text-slate-400">From: </span>
                    <span className="text-slate-700 dark:text-slate-300 font-medium">
                      {formatDate(snapshot.first_message_date)}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 dark:text-slate-400">To: </span>
                    <span className="text-slate-700 dark:text-slate-300 font-medium">
                      {formatDate(snapshot.last_message_date)}
                    </span>
                  </div>
                </div>

                {/* ID (truncated) */}
                <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-700">
                  <span className="text-xs text-slate-400 dark:text-slate-500 font-mono">
                    {snapshot.id.substring(0, 8)}...
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>

        {/* Pagination */}
        {(page > 1 || pagination.hasMore) && (
          <div className="flex justify-center gap-4 mt-8">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-6 py-2 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-lg border border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Previous
            </button>
            <span className="px-6 py-2 bg-blue-600 text-white rounded-lg font-semibold">
              Page {page}
            </span>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={!pagination.hasMore}
              className="px-6 py-2 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-lg border border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
