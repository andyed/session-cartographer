import '../styles/session-identity.css';

/** Shared identity for a named task and the transcript that supplies its evidence. */
export default function SessionIdentity({ title, sessionId, provider, cwd, heading: Heading = 'h3', headingRef, headingTabIndex, children }) {
  const id = String(sessionId || '');
  const name = title?.trim() || (id.startsWith('Legacy ') ? id : 'Untitled session');
  return <div className="session-identity">
    <Heading ref={headingRef} tabIndex={headingTabIndex} className="session-identity-title">{name}</Heading>
    {(provider || id || cwd || children) && <div className="session-identity-context">
      {provider && <span>{provider}</span>}
      {id && !id.startsWith('Legacy ') && <span className="session-identity-id" title={id}>Session {id.slice(0, 8)}</span>}
      {cwd && <span className="session-identity-cwd" title={cwd}>{cwd}</span>}
      {children}
    </div>}
  </div>;
}
