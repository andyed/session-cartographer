export const EVENT_STREAM_READY_STATE = Object.freeze({
  CONNECTING: 0,
  OPEN: 1,
  CLOSED: 2,
});

export function initialEventStreamStatus(disabled = false) {
  return { state: disabled ? 'disabled' : 'connecting', attempts: 0 };
}

export function transitionEventStreamStatus(status, event, readyState = EVENT_STREAM_READY_STATE.CONNECTING) {
  if (status?.state === 'disabled') return status;
  if (event === 'open' || event === 'message') return { state: 'live', attempts: 0 };
  if (event !== 'error') return status;
  return {
    state: readyState === EVENT_STREAM_READY_STATE.CLOSED ? 'offline' : 'reconnecting',
    attempts: (status?.attempts || 0) + 1,
  };
}

export function eventStreamPresentation(status) {
  switch (status?.state) {
    case 'live':
      return { label: 'Live', detail: 'New events arrive automatically.', tone: 'live' };
    case 'reconnecting':
      return { label: 'Reconnecting', detail: 'The event stream was interrupted. Explorer is retrying automatically.', tone: 'waiting' };
    case 'offline':
      return { label: 'Offline', detail: 'The event stream closed. Reload Explorer to reconnect.', tone: 'offline' };
    case 'connecting':
      return { label: 'Connecting', detail: 'Opening the live event stream.', tone: 'waiting' };
    default:
      return null;
  }
}
