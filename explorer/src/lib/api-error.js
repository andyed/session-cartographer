// Kept apart from api.js, which reads import.meta.env at load, so Node tests can import it.

export class ExplorerApiError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.name = 'ExplorerApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * A request that never got an HTTP answer, in words a person can act on. The
 * browser says "Failed to fetch" for a stopped server and "signal timed out"
 * for a deadline; the caller's own abort is returned unchanged.
 */
export function explainRequestFailure(error, signal) {
  if (signal?.aborted && signal.reason?.name !== 'TimeoutError') return error;
  if (error?.name === 'TimeoutError' || signal?.reason?.name === 'TimeoutError') {
    return new ExplorerApiError('Cartographer took too long to answer.', { code: 'request-timeout' });
  }
  if (error?.name === 'TypeError') {
    return new ExplorerApiError('Cannot reach Cartographer. It may have stopped.', { code: 'connection-unavailable' });
  }
  return error;
}
