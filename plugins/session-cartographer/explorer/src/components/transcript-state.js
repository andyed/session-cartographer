export function transcriptFailure(error) {
  if (error?.name === 'AbortError') return null;

  const status = Number(error?.status) || 0;
  const code = error?.code || '';
  const detail = error?.message || 'Unknown transcript error';

  if (status === 404 || code === 'TRANSCRIPT_NOT_FOUND' || code === 'TRANSCRIPT_EMPTY') {
    return {
      title: 'Transcript unavailable',
      message: 'The source transcript is missing or no longer contains readable session data.',
      detail,
    };
  }
  if (status === 403 || code === 'TRANSCRIPT_FORBIDDEN') {
    return {
      title: 'Transcript access blocked',
      message: 'This path is outside the transcript stores Explorer is allowed to read.',
      detail,
    };
  }
  if (status === 422 || code === 'TRANSCRIPT_NO_MESSAGES') {
    return {
      title: 'No conversation to display',
      message: 'The transcript exists, but it has no readable user or assistant messages.',
      detail,
    };
  }
  if (status === 503 || code === 'TRANSCRIPT_UNREADABLE') {
    return {
      title: 'Transcript temporarily unreadable',
      message: 'Explorer found the transcript but could not read it. Check file permissions, then retry.',
      detail,
    };
  }
  return {
    title: 'Could not load transcript',
    message: status === 0
      ? 'Explorer lost contact with its local server. The rest of the app is still available.'
      : 'Explorer could not read this transcript response. You can retry without leaving the session.',
    detail,
  };
}

export function transcriptAnalysisNotice(value) {
  if (!value) return null;
  const message = value?.unavailable?.message || value?.message || 'Session analysis is unavailable.';
  return {
    label: 'Basic view',
    detail: `${message} Conversation text is still available.`,
  };
}
