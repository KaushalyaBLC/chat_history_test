'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { decryptSnapshot, downloadDecryptedSnapshot } from '@/lib/decrypt-snapshot';
import {
  decryptAndStreamToIndexedDBMultiWorker,
  configureMultiWorker,
  getOptimalWorkerCount,
} from '@/lib/decrypt-snapshot-streaming-multiworker';
import {
  getCachedSnapshot,
  getCachedMessages,
  searchCachedMessages,
  deleteCachedSnapshot,
  type StreamingProgress,
} from '@/lib/decrypt-snapshot-streaming';
import type { Message, SnapshotMetadata } from '@/lib/indexeddb-manager';

interface SnapshotDetail {
  id: string;
  message_count: number;
  file_size: string;
  status: string;
  first_message_date: string;
  last_message_date: string;
  snapshot_private_key?: string;
  file_url?: string;
}

interface SnapshotResponse {
  success: boolean;
  message: string;
  data: SnapshotDetail;
}

const MANUAL_WORKER_MIN = 2;
const MANUAL_WORKER_MAX = 12;

export default function SnapshotDetailPage() {
  const params = useParams();
  const id = params.id as string;

  const [snapshot, setSnapshot] = useState<SnapshotDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [copiedPrivateKey, setCopiedPrivateKey] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [decryptStatus, setDecryptStatus] = useState<string>('');

  // IndexedDB states
  const [cachedMetadata, setCachedMetadata] = useState<SnapshotMetadata | null>(null);
  const [isLoadingToIndexedDB, setIsLoadingToIndexedDB] = useState(false);
  const [streamingProgress, setStreamingProgress] = useState<StreamingProgress | null>(null);
  const [showMessagesViewer, setShowMessagesViewer] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [messagesPerPage] = useState(50);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const optimalWorkerCount = useMemo(() => getOptimalWorkerCount(), []);
  const [workerCountMode, setWorkerCountMode] = useState<'auto' | 'manual'>('auto');
  const [manualWorkerCount, setManualWorkerCount] = useState(
    Math.max(MANUAL_WORKER_MIN, Math.min(MANUAL_WORKER_MAX, optimalWorkerCount))
  );
  const [lastWorkerCountUsed, setLastWorkerCountUsed] = useState<number | null>(null);
  const clampWorkerCount = (value: number) =>
    Math.max(MANUAL_WORKER_MIN, Math.min(MANUAL_WORKER_MAX, value));
  const effectiveWorkerCount = workerCountMode === 'auto' ? optimalWorkerCount : manualWorkerCount;

  useEffect(() => {
    if (id) {
      fetchSnapshot(id);
      checkCachedSnapshot();
    }
  }, [id]);

  useEffect(() => {
    if (showMessagesViewer && cachedMetadata) {
      loadMessages();
    }
  }, [currentPage, showMessagesViewer]);

  const checkCachedSnapshot = async () => {
    try {
      const cached = await getCachedSnapshot(id);
      setCachedMetadata(cached);
    } catch (error) {
      console.error('Error checking cached snapshot:', error);
    }
  };

  const loadMessages = async () => {
    try {
      const offset = (currentPage - 1) * messagesPerPage;
      const msgs = await getCachedMessages(id, {
        offset,
        limit: messagesPerPage,
      });
      setMessages(msgs);
    } catch (error) {
      console.error('Error loading messages:', error);
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      loadMessages();
      return;
    }

    try {
      setIsSearching(true);
      const results = await searchCachedMessages(id, searchQuery, 100);
      setMessages(results);
      setCurrentPage(1);
    } catch (error) {
      console.error('Error searching messages:', error);
    } finally {
      setIsSearching(false);
    }
  };

  const handleLoadToIndexedDB = async () => {
    if (!snapshot?.file_url || !snapshot?.snapshot_private_key) {
      alert('Missing file URL or private key');
      return;
    }

    try {
      setIsLoadingToIndexedDB(true);
      const resumeProcessed = cachedMetadata?.status === 'processing'
        ? cachedMetadata.processedMessages ?? 0
        : 0;
      const selectedWorkerCount = workerCountMode === 'auto'
        ? getOptimalWorkerCount()
        : clampWorkerCount(manualWorkerCount);
      const workerLabel = `${selectedWorkerCount} worker${selectedWorkerCount !== 1 ? 's' : ''}`;
      setStreamingProgress({
        stage: 'downloading',
        progress: 0,
        message: resumeProcessed > 0
          ? `Resuming from ${resumeProcessed.toLocaleString()} cached msgs with ${workerLabel}...`
          : `Initializing ${workerLabel} pipeline...`,
      });
      setLastWorkerCountUsed(selectedWorkerCount);

      configureMultiWorker({
        workerCount: selectedWorkerCount,
        enablePerformanceLogs: true,
      });

      console.log(`🚀 Starting multi-worker processing with ${selectedWorkerCount} workers (${workerCountMode} mode)`);

      await decryptAndStreamToIndexedDBMultiWorker(
        id,
        snapshot.file_url,
        snapshot.snapshot_private_key,
        (progress: StreamingProgress) => {
          setStreamingProgress(progress);
        }
      );

      // Refresh cached metadata
      await checkCachedSnapshot();
      setShowMessagesViewer(true);
    } catch (error) {
      console.error('Failed to load to IndexedDB:', error);
      alert(`Failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsLoadingToIndexedDB(false);
      setTimeout(() => setStreamingProgress(null), 3000);
    }
  };

  const handleDeleteCache = async () => {
    if (!confirm('Delete this snapshot from IndexedDB? This cannot be undone.')) {
      return;
    }

    try {
      await deleteCachedSnapshot(id);
      setCachedMetadata(null);
      setShowMessagesViewer(false);
      setMessages([]);
    } catch (error) {
      console.error('Error deleting cache:', error);
      alert('Failed to delete cache');
    }
  };

  const fetchSnapshot = async (snapshotId: string) => {
    try {
      setLoading(true);
      const response = await fetch(`/api/snapshots/${snapshotId}`);

      if (!response.ok) {
        throw new Error('Failed to fetch snapshot details');
      }

      const data: SnapshotResponse = await response.json();

      if (data.success) {
        setSnapshot(data.data);
      } else {
        setError(data.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const calculateDuration = (start: string, end: string) => {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const diffMs = endDate.getTime() - startDate.getTime();
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m`;
  };

  const formatDurationDisplay = (durationMs?: number | null) => {
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
      return null;
    }
    if (durationMs >= 1000) {
      return `${(durationMs / 1000).toFixed(2)}s`;
    }
    return `${Math.round(durationMs)}ms`;
  };

  const decryptDurationDisplay =
    streamingProgress?.stage === 'completed'
      ? formatDurationDisplay(streamingProgress.decryptDurationMs)
      : null;
  const insertDurationDisplay =
    streamingProgress?.stage === 'completed'
      ? formatDurationDisplay(streamingProgress.insertDurationMs)
      : null;
  const resumeDetected = cachedMetadata?.status === 'processing' && (cachedMetadata.processedMessages ?? 0) > 0;
  const resumeStatusCopy = resumeDetected
    ? `${cachedMetadata?.processedMessages?.toLocaleString() ?? '0'} / ${cachedMetadata?.totalMessages?.toLocaleString() ?? '?'}` 
    : null;
  const loadButtonLabel = resumeDetected ? 'Resume Loading' : 'Load to IndexedDB';
  const workerSummary = `${effectiveWorkerCount} worker${effectiveWorkerCount !== 1 ? 's' : ''}`;

  const copyToClipboard = async (text: string, type: 'id' | 'privateKey') => {
    await navigator.clipboard.writeText(text);
    if (type === 'id') {
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2000);
    } else {
      setCopiedPrivateKey(true);
      setTimeout(() => setCopiedPrivateKey(false), 2000);
    }
  };

  const handleDecryptAndDownload = async () => {
    if (!snapshot?.file_url || !snapshot?.snapshot_private_key) {
      alert('Missing file URL or private key');
      return;
    }

    try {
      setIsDecrypting(true);
      setDecryptStatus('Starting decryption...');

      const decryptedData = await decryptSnapshot(
        snapshot.file_url,
        snapshot.snapshot_private_key,
        (status) => setDecryptStatus(status)
      );

      setDecryptStatus('Download starting...');

      // Generate filename from snapshot ID and date
      const date = new Date(snapshot.first_message_date).toISOString().split('T')[0];
      const filename = `snapshot-${date}-${snapshot.id.substring(0, 8)}.json`;

      downloadDecryptedSnapshot(decryptedData, filename);

      setDecryptStatus('Complete!');
      setTimeout(() => setDecryptStatus(''), 3000);
    } catch (error) {
      console.error('Decryption failed:', error);
      setDecryptStatus('');
      alert(`Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsDecrypting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-slate-600 dark:text-slate-400">Loading snapshot details...</p>
        </div>
      </div>
    );
  }

  if (error || !snapshot) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6 max-w-md">
          <h2 className="text-red-800 dark:text-red-400 text-lg font-semibold mb-2">Error</h2>
          <p className="text-red-600 dark:text-red-300">{error || 'Snapshot not found'}</p>
          <div className="flex gap-3 mt-4">
            <button
              onClick={() => fetchSnapshot(id)}
              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
            >
              Retry
            </button>
            <Link
              href="/"
              className="px-4 py-2 bg-slate-600 text-white rounded-lg hover:bg-slate-700 transition-colors"
            >
              Go Back
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Back Button */}
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 mb-6 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Snapshots
        </Link>

        {/* Main Card */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-blue-500 to-blue-600 dark:from-blue-600 dark:to-blue-700 p-6">
            <div className="flex items-center justify-between">
              <h1 className="text-3xl font-bold text-white">Snapshot Details</h1>
              <span
                className={`px-4 py-2 rounded-full text-sm font-semibold ${
                  snapshot.status === 'completed'
                    ? 'bg-green-100 text-green-800'
                    : 'bg-yellow-100 text-yellow-800'
                }`}
              >
                {snapshot.status}
              </span>
            </div>
          </div>

          {/* Content */}
          <div className="p-8">
            {/* Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
              {/* Message Count */}
              <div className="bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/20 dark:to-blue-800/20 rounded-xl p-6 border border-blue-200 dark:border-blue-700">
                <div className="flex items-center gap-3 mb-2">
                  <svg className="w-6 h-6 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                  </svg>
                  <h3 className="text-sm font-medium text-slate-600 dark:text-slate-400">Total Messages</h3>
                </div>
                <p className="text-4xl font-bold text-blue-600 dark:text-blue-400">
                  {snapshot.message_count.toLocaleString()}
                </p>
              </div>

              {/* File Size */}
              <div className="bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20 rounded-xl p-6 border border-purple-200 dark:border-purple-700">
                <div className="flex items-center gap-3 mb-2">
                  <svg className="w-6 h-6 text-purple-600 dark:text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                  <h3 className="text-sm font-medium text-slate-600 dark:text-slate-400">File Size</h3>
                </div>
                <p className="text-4xl font-bold text-purple-600 dark:text-purple-400 uppercase">
                  {snapshot.file_size}
                </p>
              </div>
            </div>

            {/* Timeline Section */}
            <div className="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                <svg className="w-5 h-5 text-slate-600 dark:text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Timeline
              </h3>

              <div className="space-y-4">
                {/* Start Date */}
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0 w-24 text-sm font-medium text-slate-600 dark:text-slate-400">
                    Started
                  </div>
                  <div className="flex-1">
                    <div className="text-slate-900 dark:text-white font-medium">
                      {formatDate(snapshot.first_message_date)}
                    </div>
                  </div>
                </div>

                {/* Divider with duration */}
                <div className="flex items-center gap-4 pl-24">
                  <div className="flex-1 border-l-2 border-dashed border-slate-300 dark:border-slate-600 pl-4 py-2">
                    <span className="text-sm text-slate-500 dark:text-slate-400">
                      Duration: {calculateDuration(snapshot.first_message_date, snapshot.last_message_date)}
                    </span>
                  </div>
                </div>

                {/* End Date */}
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0 w-24 text-sm font-medium text-slate-600 dark:text-slate-400">
                    Ended
                  </div>
                  <div className="flex-1">
                    <div className="text-slate-900 dark:text-white font-medium">
                      {formatDate(snapshot.last_message_date)}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Snapshot ID */}
            <div className="mt-6 p-4 bg-slate-100 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-700">
              <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0 mr-4">
                  <h3 className="text-sm font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Snapshot ID
                  </h3>
                  <p className="text-sm font-mono text-slate-900 dark:text-white break-all">
                    {snapshot.id}
                  </p>
                </div>
                <button
                  onClick={() => copyToClipboard(snapshot.id, 'id')}
                  className="shrink-0 px-3 py-2 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-lg hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors text-sm font-medium"
                >
                  {copiedId ? '✓ Copied' : 'Copy ID'}
                </button>
              </div>
            </div>

            {/* Private Key Section */}
            {snapshot.snapshot_private_key && (
              <div className="mt-6 p-4 bg-amber-50 dark:bg-amber-900/10 rounded-lg border border-amber-200 dark:border-amber-800">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <svg className="w-5 h-5 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                    <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-400">
                      Snapshot Private Key
                    </h3>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowPrivateKey(!showPrivateKey)}
                      className="px-3 py-1.5 bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-200 rounded-lg hover:bg-amber-300 dark:hover:bg-amber-700 transition-colors text-sm font-medium"
                    >
                      {showPrivateKey ? 'Hide' : 'Show'}
                    </button>
                    {showPrivateKey && (
                      <button
                        onClick={() => copyToClipboard(snapshot.snapshot_private_key!, 'privateKey')}
                        className="px-3 py-1.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors text-sm font-medium"
                      >
                        {copiedPrivateKey ? '✓ Copied' : 'Copy'}
                      </button>
                    )}
                  </div>
                </div>
                {showPrivateKey ? (
                  <pre className="mt-3 p-3 bg-slate-900 dark:bg-slate-950 text-green-400 rounded-lg text-xs overflow-x-auto border border-slate-700">
                    {snapshot.snapshot_private_key}
                  </pre>
                ) : (
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    Private key is hidden for security. Click "Show" to reveal.
                  </p>
                )}
                <div className="mt-3 flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
                  <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <span>Keep this private key secure. Do not share it publicly.</span>
                </div>
              </div>
            )}

            {/* Download File Section */}
            {snapshot.file_url && (
              <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-900/10 rounded-lg border border-blue-200 dark:border-blue-800">
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-blue-100 dark:bg-blue-800 rounded-lg">
                        <svg className="w-6 h-6 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
                        </svg>
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-blue-800 dark:text-blue-400 mb-1">
                          Snapshot File
                        </h3>
                        <p className="text-xs text-blue-600 dark:text-blue-300">
                          Download encrypted or decrypted snapshot
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex flex-col sm:flex-row gap-3">
                    <a
                      href={snapshot.file_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium flex items-center justify-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      Download Encrypted
                    </a>

                    {snapshot.snapshot_private_key && (
                      <button
                        onClick={handleDecryptAndDownload}
                        disabled={isDecrypting}
                        className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-green-400 disabled:cursor-not-allowed transition-colors text-sm font-medium flex items-center justify-center gap-2"
                      >
                        {isDecrypting ? (
                          <>
                            <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                            <span>{decryptStatus || 'Decrypting...'}</span>
                          </>
                        ) : (
                          <>
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                            </svg>
                            Decrypt & Download
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  {/* Status Message */}
                  {decryptStatus && !isDecrypting && (
                    <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400 bg-green-100 dark:bg-green-900/30 px-3 py-2 rounded-lg">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      {decryptStatus}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* IndexedDB Section */}
            {snapshot.file_url && snapshot.snapshot_private_key && (
              <div className="mt-6 p-4 bg-purple-50 dark:bg-purple-900/10 rounded-lg border border-purple-200 dark:border-purple-800">
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-purple-100 dark:bg-purple-800 rounded-lg">
                        <svg className="w-6 h-6 text-purple-600 dark:text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
                        </svg>
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-purple-800 dark:text-purple-400 mb-1">
                          IndexedDB Browser Cache
                        </h3>
                        <p className="text-xs text-purple-600 dark:text-purple-300">
                          {cachedMetadata?.status === 'completed'
                            ? `${cachedMetadata.processedMessages?.toLocaleString()} messages cached`
                            : 'Load messages to browser for instant access'}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-purple-200 dark:border-purple-700 bg-white/70 dark:bg-slate-900/40 p-3">
                    <div className="flex items-center justify-between text-xs text-purple-700 dark:text-purple-200">
                      <span className="font-semibold">Worker allocation</span>
                      <span>
                        {workerCountMode === 'auto'
                          ? `Auto • ${optimalWorkerCount} workers`
                          : `Manual • ${manualWorkerCount} workers`}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2 mt-3">
                      <button
                        type="button"
                        onClick={() => setWorkerCountMode('auto')}
                        className={`px-3 py-1.5 rounded-md border text-xs font-medium transition-colors ${
                          workerCountMode === 'auto'
                            ? 'bg-purple-600 text-white border-purple-600'
                            : 'bg-transparent text-purple-700 dark:text-purple-200 border-purple-300 dark:border-purple-700'
                        }`}
                      >
                        Auto
                      </button>
                      <button
                        type="button"
                        onClick={() => setWorkerCountMode('manual')}
                        className={`px-3 py-1.5 rounded-md border text-xs font-medium transition-colors ${
                          workerCountMode === 'manual'
                            ? 'bg-purple-600 text-white border-purple-600'
                            : 'bg-transparent text-purple-700 dark:text-purple-200 border-purple-300 dark:border-purple-700'
                        }`}
                      >
                        Manual
                      </button>
                    </div>
                    {workerCountMode === 'manual' ? (
                      <div className="mt-4 space-y-1">
                        <input
                          type="range"
                          min={MANUAL_WORKER_MIN}
                          max={MANUAL_WORKER_MAX}
                          value={manualWorkerCount}
                          onChange={(e) => setManualWorkerCount(clampWorkerCount(Number(e.target.value)))}
                          className="w-full accent-purple-600"
                        />
                        <div className="flex justify-between text-[11px] text-purple-500 dark:text-purple-300">
                          <span>{MANUAL_WORKER_MIN}</span>
                          <span>{MANUAL_WORKER_MAX}</span>
                        </div>
                        <p className="text-xs text-purple-700 dark:text-purple-300">
                          Using {manualWorkerCount} worker{manualWorkerCount !== 1 ? 's' : ''}. Increase slowly to avoid locking up the browser.
                        </p>
                      </div>
                    ) : (
                      <p className="text-xs text-purple-700 dark:text-purple-300 mt-3">
                        Auto mode adapts to your hardware ({optimalWorkerCount} worker{optimalWorkerCount !== 1 ? 's' : ''}).
                      </p>
                    )}
                  </div>

                  {resumeDetected && (
                    <div className="flex items-start gap-2 text-xs text-purple-700 dark:text-purple-200 bg-purple-100/80 dark:bg-purple-900/40 border border-dashed border-purple-300 dark:border-purple-700 px-3 py-2 rounded-lg">
                      <svg className="w-4 h-4 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span>
                        Partial cache detected ({resumeStatusCopy}). Resuming will skip already processed messages automatically.
                      </span>
                    </div>
                  )}

                  {/* Action Buttons */}
                  <div className="flex flex-col sm:flex-row gap-3">
                    {!cachedMetadata || cachedMetadata.status !== 'completed' ? (
                      <button
                        onClick={handleLoadToIndexedDB}
                        disabled={isLoadingToIndexedDB}
                        className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:bg-purple-400 disabled:cursor-not-allowed transition-colors text-sm font-medium flex items-center justify-center gap-2"
                      >
                        {isLoadingToIndexedDB ? (
                          <>
                            <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                            <span>{streamingProgress?.message || 'Loading...'}</span>
                          </>
                        ) : (
                          <>
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                            </svg>
                            <div className="text-left">
                              <div>{loadButtonLabel}</div>
                              <div className="text-xs text-purple-200">Using {workerSummary}</div>
                            </div>
                          </>
                        )}
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() => setShowMessagesViewer(!showMessagesViewer)}
                          className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-medium flex items-center justify-center gap-2"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </svg>
                          {showMessagesViewer ? 'Hide' : 'View'} Messages
                        </button>
                        <button
                          onClick={handleDeleteCache}
                          className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium flex items-center justify-center gap-2"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                          Delete Cache
                        </button>
                      </>
                    )}
                  </div>

                  {/* Progress Bar */}
                  {streamingProgress && isLoadingToIndexedDB && (
                    <div className="space-y-2">
                      <div className="flex justify-between text-xs text-purple-700 dark:text-purple-300">
                        <span>{streamingProgress.message}</span>
                        <span>{streamingProgress.progress}%</span>
                      </div>
                      <div className="w-full bg-purple-200 dark:bg-purple-900 rounded-full h-2">
                        <div
                          className="bg-purple-600 dark:bg-purple-500 h-2 rounded-full transition-all duration-300"
                          style={{ width: `${streamingProgress.progress}%` }}
                        ></div>
                      </div>
                      {streamingProgress.processedMessages !== undefined && (
                        <p className="text-xs text-purple-600 dark:text-purple-400">
                          Processed {streamingProgress.processedMessages?.toLocaleString()} / {streamingProgress.totalMessages?.toLocaleString()} messages
                        </p>
                      )}
                    </div>
                  )}

                  {/* Success Message */}
                  {streamingProgress && !isLoadingToIndexedDB && streamingProgress.stage === 'completed' && (
                    <div className="flex items-start gap-3 text-sm text-purple-700 dark:text-purple-400 bg-purple-100 dark:bg-purple-900/30 px-3 py-2 rounded-lg">
                      <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <div className="flex flex-col gap-1">
                        <span>{streamingProgress.message}</span>
                        {(decryptDurationDisplay || insertDurationDisplay || lastWorkerCountUsed) && (
                          <div className="text-xs text-purple-600 dark:text-purple-300 flex flex-wrap gap-4">
                            {decryptDurationDisplay && <span>Decrypt: {decryptDurationDisplay}</span>}
                            {insertDurationDisplay && <span>Insert: {insertDurationDisplay}</span>}
                            {lastWorkerCountUsed && <span>Workers used: {lastWorkerCountUsed}</span>}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Messages Viewer */}
            {showMessagesViewer && cachedMetadata && (
              <div className="mt-6 p-4 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-700">
                <div className="flex flex-col gap-4">
                  {/* Search Bar */}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                      placeholder="Search messages..."
                      className="flex-1 px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                    <button
                      onClick={handleSearch}
                      disabled={isSearching}
                      className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:bg-purple-400 transition-colors flex items-center gap-2"
                    >
                      {isSearching ? (
                        <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                      )}
                      Search
                    </button>
                  </div>

                  {/* Messages List */}
                  <div className="space-y-3 max-h-[600px] overflow-y-auto">
                    {messages.length === 0 ? (
                      <p className="text-center text-slate-500 dark:text-slate-400 py-8">
                        No messages found
                      </p>
                    ) : (
                      messages.map((msg) => (
                        <div
                          key={msg.id}
                          className="bg-white dark:bg-slate-800 p-4 rounded-lg border border-slate-200 dark:border-slate-700"
                        >
                          <div className="flex items-start justify-between gap-3 mb-2">
                            <div className="flex-1">
                              <span className={`inline-block px-2 py-1 rounded text-xs font-medium ${
                                msg.type === 'user'
                                  ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
                                  : 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                              }`}>
                                {msg.type}
                              </span>
                              {msg.oleon_convos_users?.nick_name && (
                                <span className="ml-2 text-sm text-slate-600 dark:text-slate-400">
                                  {msg.oleon_convos_users.nick_name}
                                </span>
                              )}
                            </div>
                            <span className="text-xs text-slate-500 dark:text-slate-400">
                              {new Date(msg.created_at).toLocaleString()}
                            </span>
                          </div>
                          <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
                            {msg.message}
                          </p>
                        </div>
                      ))
                    )}
                  </div>

                  {/* Pagination */}
                  {!searchQuery && messages.length > 0 && (
                    <div className="flex items-center justify-between pt-4 border-t border-slate-200 dark:border-slate-700">
                      <button
                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                        disabled={currentPage === 1}
                        className="px-4 py-2 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-lg hover:bg-slate-300 dark:hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                      >
                        Previous
                      </button>
                      <span className="text-sm text-slate-600 dark:text-slate-400">
                        Page {currentPage} • Showing {messages.length} messages
                      </span>
                      <button
                        onClick={() => setCurrentPage(p => p + 1)}
                        disabled={messages.length < messagesPerPage}
                        className="px-4 py-2 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-lg hover:bg-slate-300 dark:hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                      >
                        Next
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
