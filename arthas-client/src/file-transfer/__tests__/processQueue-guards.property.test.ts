/**
 * @file processQueue-guards.property.test.ts — Property tests for processQueue defensive guards
 *
 * Tests the hardened processQueue → sendFile bridge in fileTransferStore.ts:
 * - Property 6: Catch handler propagates sendFile errors to transfer state
 * - Property 7: Pre-flight connection check fails transfer when disconnected
 * - Property 8: Transfer validity guard prevents stale sendFile invocation
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**
 *
 * @module file-transfer/__tests__/processQueue-guards.property.test
 * @see fileTransferStore.ts — processQueue() implementation
 * @see design.md — Correctness Properties 6, 7, 8
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import type { TransferState } from '../types';

// ============================================================================
// Mock Dependencies
// ============================================================================

// Hoist mock functions so they're available in vi.mock factories
const {
  mockIsConnected,
  mockSendFile,
  mockRemoveFileRef,
  mockSend,
} = vi.hoisted(() => ({
  mockIsConnected: vi.fn(() => true),
  mockSendFile: vi.fn(async () => {}),
  mockRemoveFileRef: vi.fn(),
  mockSend: vi.fn(),
}));

// Mock websocket module
vi.mock('../../network/websocket', () => ({
  send: mockSend,
  isConnected: mockIsConnected,
  getWs: vi.fn(() => ({ bufferedAmount: 0 })),
}));

// Mock sender module — sendFile and removeFileRef
vi.mock('../sender', () => ({
  storeFileRef: vi.fn(),
  sendFile: mockSendFile,
  removeFileRef: mockRemoveFileRef,
}));

// Mock chatStore
vi.mock('../../stores/chatStore', () => ({
  useChatStore: {
    getState: vi.fn(() => ({
      myId: 'test-user',
      myName: 'TestUser',
      members: [],
      roomKey: { type: 'secret' } as unknown as CryptoKey, // Non-null roomKey
    })),
    setState: vi.fn(),
  },
}));

// Mock receiver module to prevent import issues
vi.mock('../receiver', () => ({
  handleFileMeta: vi.fn(),
  handleFileChunk: vi.fn(),
  handleFileComplete: vi.fn(),
  handleFileCancel: vi.fn(),
  handleSenderLeft: vi.fn(),
}));

// Mock i18n
vi.mock('../../i18n/store', () => ({
  useI18nStore: {
    getState: vi.fn(() => ({ language: 'en' })),
  },
}));

vi.mock('../../i18n/translate', () => ({
  translate: vi.fn((key: string) => key),
}));

// Mock thumbnail
vi.mock('../thumbnail', () => ({
  generateThumbnail: vi.fn(async () => null),
}));

// Mock encryptChunk
vi.mock('../encryptChunk', () => ({
  encryptChunk: vi.fn(async () => ({
    iv: new Uint8Array(12),
    ciphertext: new Uint8Array(64),
  })),
}));

// Mock chunker
vi.mock('../chunker', () => ({
  streamChunks: vi.fn(async function* () {
    yield { index: 0, data: new ArrayBuffer(64) };
  }),
}));

// Mock crypto utils
vi.mock('../../crypto/utils', () => ({
  toBase64Url: vi.fn(() => 'mock-iv'),
}));

// Import the real store AFTER mocks are set up
import { useFileTransferStore, triggerProcessQueue } from '../fileTransferStore';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a minimal TransferState for testing (pending status, ready for processQueue).
 */
function createPendingTransfer(overrides: Partial<TransferState> = {}): TransferState {
  return {
    transferId: 'test-transfer-001',
    direction: 'send',
    status: 'pending',
    fileName: 'test-file.txt',
    fileSize: 1024,
    mimeType: 'text/plain',
    totalChunks: 1,
    receivedChunks: 0,
    lastReceivedIndex: -1,
    chunks: [],
    startTime: Date.now(),
    lastChunkTime: Date.now(),
    senderId: '',
    senderName: '',
    ackCount: 0,
    totalReceivers: 0,
    chatMessageId: '',
    ...overrides,
  };
}

/**
 * Set up a transfer in the store and queue it for sending.
 */
function queueTransfer(transfer: TransferState): void {
  useFileTransferStore.setState((state) => {
    const newTransfers = new Map(state.transfers);
    newTransfers.set(transfer.transferId, transfer);
    return {
      transfers: newTransfers,
      sendQueue: [...state.sendQueue, transfer.transferId],
      activeSendId: null,
    };
  });
}

/**
 * Reset store to clean state.
 */
function resetStore(): void {
  useFileTransferStore.setState({
    transfers: new Map(),
    sendQueue: [],
    activeSendId: null,
    activeReceiveCount: 0,
  });
}

/**
 * Arbitrary for generating valid transfer IDs (NanoID-like strings).
 */
const transferIdArb = fc.string({ minLength: 10, maxLength: 21 })
  .filter(s => s.trim().length >= 10);

/**
 * Arbitrary for generating error messages.
 */
const errorMessageArb = fc.string({ minLength: 1, maxLength: 200 })
  .filter(s => s.trim().length > 0);

/**
 * Arbitrary for generating valid file names.
 */
const fileNameArb = fc.string({ minLength: 1, maxLength: 50 })
  .filter(s => s.trim().length > 0);

/**
 * Arbitrary for generating valid file sizes (1 byte to 5MB).
 */
const fileSizeArb = fc.integer({ min: 1, max: 5_242_880 });

// ============================================================================
// Property 6: Catch handler propagates sendFile errors to transfer state
// ============================================================================

describe('Property 6: Catch handler propagates sendFile errors to transfer state', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    // Default: connection is available
    mockIsConnected.mockReturnValue(true);
  });

  afterEach(() => {
    resetStore();
  });

  /**
   * Property 6: For any error thrown or rejected by sendFile(), the .catch()
   * handler SHALL mark the active transfer as `failed` with the error message,
   * clear `activeSendId`, and trigger processQueue() to advance the queue.
   *
   * **Validates: Requirements 2.1**
   */
  it('for any error rejected by sendFile, transfer is marked failed with error message', async () => {
    await fc.assert(
      fc.asyncProperty(
        transferIdArb,
        errorMessageArb,
        fileNameArb,
        fileSizeArb,
        async (transferId, errorMsg, fileName, fileSize) => {
          // Reset state for each iteration
          resetStore();
          vi.clearAllMocks();
          mockIsConnected.mockReturnValue(true);

          // Configure sendFile to reject with the generated error
          mockSendFile.mockRejectedValueOnce(new Error(errorMsg));

          // Set up a pending transfer in the store queue
          const transfer = createPendingTransfer({
            transferId,
            fileName,
            fileSize,
            totalChunks: Math.ceil(fileSize / 65536),
          });
          queueTransfer(transfer);

          // Trigger processQueue — this will call sendFile which rejects
          triggerProcessQueue();

          // Wait for the promise rejection to be handled by .catch()
          await vi.waitFor(() => {
            const state = useFileTransferStore.getState();
            const updatedTransfer = state.transfers.get(transferId);
            expect(updatedTransfer).toBeDefined();
            expect(updatedTransfer!.status).toBe('failed');
          }, { timeout: 1000 });

          // Assert: transfer is marked as failed with the error message
          const state = useFileTransferStore.getState();
          const updatedTransfer = state.transfers.get(transferId);
          expect(updatedTransfer!.status).toBe('failed');
          expect(updatedTransfer!.error).toBe(errorMsg);

          // Assert: activeSendId is cleared
          expect(state.activeSendId).toBeNull();

          // Assert: removeFileRef was called for cleanup
          expect(mockRemoveFileRef).toHaveBeenCalledWith(transferId);
        }
      ),
      { numRuns: 30 }
    );
  });

  /**
   * Property 6b: Non-Error objects thrown by sendFile are also caught and
   * result in a generic error message.
   *
   * **Validates: Requirements 2.1**
   */
  it('non-Error rejections are caught and result in "Unknown sendFile error"', async () => {
    await fc.assert(
      fc.asyncProperty(
        transferIdArb,
        // Generate arbitrary non-Error rejection values
        fc.oneof(fc.string(), fc.integer(), fc.constant(null), fc.constant(undefined)),
        async (transferId, rejectionValue) => {
          // Reset state for each iteration
          resetStore();
          vi.clearAllMocks();
          mockIsConnected.mockReturnValue(true);

          // Configure sendFile to reject with a non-Error value
          mockSendFile.mockRejectedValueOnce(rejectionValue);

          // Set up a pending transfer
          const transfer = createPendingTransfer({ transferId });
          queueTransfer(transfer);

          // Trigger processQueue
          triggerProcessQueue();

          // Wait for the .catch() handler to execute
          await vi.waitFor(() => {
            const state = useFileTransferStore.getState();
            const updatedTransfer = state.transfers.get(transferId);
            expect(updatedTransfer).toBeDefined();
            expect(updatedTransfer!.status).toBe('failed');
          }, { timeout: 1000 });

          // Assert: transfer is failed with generic error message
          const state = useFileTransferStore.getState();
          const updatedTransfer = state.transfers.get(transferId);
          expect(updatedTransfer!.status).toBe('failed');
          expect(updatedTransfer!.error).toBe('Unknown sendFile error');

          // Assert: activeSendId is cleared
          expect(state.activeSendId).toBeNull();
        }
      ),
      { numRuns: 30 }
    );
  });
});

// ============================================================================
// Property 7: Pre-flight connection check fails transfer when disconnected
// ============================================================================

describe('Property 7: Pre-flight connection check fails transfer when disconnected', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetStore();
  });

  /**
   * Property 7: For any queued transfer that reaches the sendFile invocation point,
   * if isConnected() returns false, the transfer SHALL be marked as `failed` with
   * a connection error message, activeSendId SHALL be cleared, sendFile() SHALL NOT
   * be invoked, and the queue SHALL advance.
   *
   * **Validates: Requirements 2.2, 2.3**
   */
  it('when disconnected, transfer is marked failed and sendFile is not called', () => {
    fc.assert(
      fc.property(
        transferIdArb,
        fileNameArb,
        fileSizeArb,
        (transferId, fileName, fileSize) => {
          // Reset state for each iteration
          resetStore();
          vi.clearAllMocks();

          // Configure isConnected to return false (disconnected)
          mockIsConnected.mockReturnValue(false);

          // Set up a pending transfer in the store queue
          const transfer = createPendingTransfer({
            transferId,
            fileName,
            fileSize,
            totalChunks: Math.ceil(fileSize / 65536),
          });
          queueTransfer(transfer);

          // Trigger processQueue
          triggerProcessQueue();

          // Assert: transfer is marked as failed with connection error
          const state = useFileTransferStore.getState();
          const updatedTransfer = state.transfers.get(transferId);
          expect(updatedTransfer).toBeDefined();
          expect(updatedTransfer!.status).toBe('failed');
          expect(updatedTransfer!.error).toContain('WebSocket');

          // Assert: activeSendId is cleared
          expect(state.activeSendId).toBeNull();

          // Assert: sendFile was NOT called
          expect(mockSendFile).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property 7b: When disconnected with multiple queued transfers, only the first
   * transfer is failed and the queue advances (subsequent transfers also fail due
   * to continued disconnection, but each is processed individually).
   *
   * **Validates: Requirements 2.2, 2.3**
   */
  it('queue advances after connection failure - each queued transfer is processed', () => {
    fc.assert(
      fc.property(
        fc.array(transferIdArb, { minLength: 2, maxLength: 3 }),
        (transferIds) => {
          // Ensure unique IDs
          const uniqueIds = [...new Set(transferIds)];
          if (uniqueIds.length < 2) return; // Skip if not enough unique IDs

          // Reset state
          resetStore();
          vi.clearAllMocks();
          mockIsConnected.mockReturnValue(false);

          // Queue multiple transfers
          for (const id of uniqueIds) {
            const transfer = createPendingTransfer({ transferId: id });
            useFileTransferStore.setState((state) => {
              const newTransfers = new Map(state.transfers);
              newTransfers.set(id, transfer);
              return {
                transfers: newTransfers,
                sendQueue: [...state.sendQueue, id],
              };
            });
          }

          // Trigger processQueue
          triggerProcessQueue();

          // Assert: all transfers are failed (processQueue recursively processes)
          const state = useFileTransferStore.getState();
          for (const id of uniqueIds) {
            const t = state.transfers.get(id);
            expect(t).toBeDefined();
            expect(t!.status).toBe('failed');
            expect(t!.error).toContain('WebSocket');
          }

          // Assert: queue is empty and activeSendId is null
          expect(state.sendQueue).toHaveLength(0);
          expect(state.activeSendId).toBeNull();

          // Assert: sendFile was never called
          expect(mockSendFile).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 30 }
    );
  });
});

// ============================================================================
// Property 8: Transfer validity guard prevents stale sendFile invocation
// ============================================================================

describe('Property 8: Transfer validity guard prevents stale sendFile invocation', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
  });

  afterEach(() => {
    resetStore();
  });

  /**
   * Property 8a: If the transfer no longer exists in the transfers Map at the
   * validity check point, sendFile SHALL NOT be invoked, activeSendId SHALL be
   * cleared, and the queue SHALL advance.
   *
   * **Validates: Requirements 2.4, 2.5**
   */
  it('if transfer is removed from store before sendFile, sendFile is not called', () => {
    fc.assert(
      fc.property(
        transferIdArb,
        fileNameArb,
        (transferId, fileName) => {
          // Reset state
          resetStore();
          vi.clearAllMocks();
          mockIsConnected.mockReturnValue(true);

          // Set up a pending transfer
          const transfer = createPendingTransfer({ transferId, fileName });
          queueTransfer(transfer);

          // Intercept: when isConnected is called (after the setState that marks sending),
          // remove the transfer from the store to simulate a race condition.
          // The processQueue function first marks as sending, then checks isConnected,
          // then re-reads the transfer. We simulate deletion between these steps.
          mockIsConnected.mockImplementation(() => {
            // Remove the transfer from the store at this point to simulate race condition
            const state = useFileTransferStore.getState();
            const newTransfers = new Map(state.transfers);
            newTransfers.delete(transferId);
            useFileTransferStore.setState({ transfers: newTransfers });
            return true; // Connection is fine
          });

          // Trigger processQueue
          triggerProcessQueue();

          // Assert: sendFile was NOT called (validity guard prevented it)
          expect(mockSendFile).not.toHaveBeenCalled();

          // Assert: activeSendId is cleared
          const state = useFileTransferStore.getState();
          expect(state.activeSendId).toBeNull();
        }
      ),
      { numRuns: 30 }
    );
  });

  /**
   * Property 8b: If the transfer status is not `sending` at the validity check
   * point (e.g., cancelled during the async gap), sendFile SHALL NOT be invoked.
   *
   * **Validates: Requirements 2.4, 2.5**
   */
  it('if transfer status is not sending at validity check, sendFile is not called', () => {
    fc.assert(
      fc.property(
        transferIdArb,
        fc.constantFrom('cancelled', 'failed', 'complete', 'pending') as fc.Arbitrary<'cancelled' | 'failed' | 'complete' | 'pending'>,
        (transferId, staleStatus) => {
          // Reset state
          resetStore();
          vi.clearAllMocks();
          mockIsConnected.mockReturnValue(true);

          // Set up a pending transfer
          const transfer = createPendingTransfer({ transferId });
          queueTransfer(transfer);

          // Intercept: when isConnected is called, change the transfer status
          // to simulate a race condition (e.g., user cancelled between setState and sendFile)
          mockIsConnected.mockImplementation(() => {
            const state = useFileTransferStore.getState();
            const newTransfers = new Map(state.transfers);
            const t = newTransfers.get(transferId);
            if (t) {
              newTransfers.set(transferId, { ...t, status: staleStatus });
            }
            useFileTransferStore.setState({ transfers: newTransfers });
            return true; // Connection is fine
          });

          // Trigger processQueue
          triggerProcessQueue();

          // Assert: sendFile was NOT called (validity guard prevented it)
          expect(mockSendFile).not.toHaveBeenCalled();

          // Assert: activeSendId is cleared
          const state = useFileTransferStore.getState();
          expect(state.activeSendId).toBeNull();
        }
      ),
      { numRuns: 30 }
    );
  });
});
