// Display-only paths. Canonical paths remain the identity for links and reads.
const normalized = value => String(value || '').replaceAll('\\', '/');
export function commonDirectory(paths) {
  const directories = paths.filter(Boolean).map(value => normalized(value).split('/').slice(0,-1));
  if (!directories.length) return '';
  const common = directories[0].slice();
  for (const parts of directories.slice(1)) {
    let count=0;
    while(count<common.length && count<parts.length && common[count]===parts[count])count++;
    common.length=count;
  }
  const root=common.join('/');
  return root ? root+'/' : '';
}
export function relativeDisplayPath(path, root) {
  const value=normalized(path);
  return root && value.startsWith(root) ? value.slice(root.length) : value;
}
export function directoryLabel(root) {
  const parts=root.split('/').filter(Boolean);
  return (parts.length>2?'…/':'')+parts.slice(-2).join('/')+'/';
}
