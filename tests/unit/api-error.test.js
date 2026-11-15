import test from 'node:test';
import assert from 'node:assert/strict';
import { ExplorerApiError, explainRequestFailure } from '../../explorer/src/lib/api-error.js';

test('a stopped server and a deadline become actionable errors with codes the poll can recover from', () => {
  const stopped = explainRequestFailure(new TypeError('Failed to fetch'));
  assert.ok(stopped instanceof ExplorerApiError);
  assert.equal(stopped.code, 'connection-unavailable');
  assert.doesNotMatch(stopped.message, /Failed to fetch/);
  const timeout = AbortSignal.abort(new DOMException('signal timed out', 'TimeoutError'));
  assert.equal(explainRequestFailure(new DOMException('signal timed out', 'TimeoutError'), timeout).code, 'request-timeout');
  assert.equal(explainRequestFailure(new DOMException('aborted', 'AbortError'), timeout).code, 'request-timeout', 'a timed-out signal names the deadline, whatever the fetch threw');
});

test('the caller\'s own abort and an HTTP-level error pass through unchanged', () => {
  const controller = new AbortController();
  controller.abort();
  const abort = new DOMException('aborted', 'AbortError');
  assert.equal(explainRequestFailure(abort, controller.signal), abort);
  // A caller abort wins even when the fetch reported a network TypeError.
  const network = new TypeError('Failed to fetch');
  assert.equal(explainRequestFailure(network, controller.signal), network);
  const http = new ExplorerApiError('Not found', { status: 404 });
  assert.equal(explainRequestFailure(http), http);
});
