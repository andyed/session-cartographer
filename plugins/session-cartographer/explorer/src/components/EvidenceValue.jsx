import { displayValue } from './evidence-content.js';
import { safeArtifactLink } from './memory-artifact.js';

function Value({ value, renderText }) {
  if(value==null)return null;
  if(Array.isArray(value))return <div className="tr-rendered-list">{value.map((item,i)=><Value key={i} value={item} renderText={renderText}/>)}</div>;
  if(typeof value==='object')return <dl className="tr-rendered-fields">{Object.entries(value).map(([key,item])=><div key={key}><dt>{key.replaceAll('_',' ')}</dt><dd><Value value={item} renderText={renderText}/></dd></div>)}</dl>;
  const text=String(value),href=/^https?:\/\/\S+$/.test(text)&&safeArtifactLink(text);
  return href?<a href={href} target="_blank" rel="noopener noreferrer">{text}</a>:<pre>{renderText?renderText(text):text}</pre>;
}
export default function EvidenceValue({ value, renderText }) { return <Value value={displayValue(value)} renderText={renderText}/>; }
