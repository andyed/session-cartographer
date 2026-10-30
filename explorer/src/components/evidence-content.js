// Renderable evidence, never serialized transport. No evaluation of recorded code.
const plumbing = new Set(['chunk_id','wall_time_seconds','wall_time','original_token_count','session_id','call_id','tool_use_id','metadata','type','mimeType','annotations','isError','is_error']);
function jsonSequence(text) {
  const values=[];let start=0;
  while(start<text.length){
    while(/\s/.test(text[start] || '') && start<text.length)start++;
    if(start===text.length)break;
    if(!['{','['].includes(text[start]))return null;
    let depth=0,quote=false,escape=false,end=-1;
    for(let i=start;i<text.length;i++){
      const c=text[i];
      if(quote){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quote=false;continue;}
      if(c==='"')quote=true;
      else if(c==='{'||c==='[')depth++;
      else if((c==='}'||c===']')&&--depth===0){end=i+1;break;}
    }
    if(end<0)return null;
    try{values.push(JSON.parse(text.slice(start,end)));}catch{return null;}
    start=end;
  }
  return values;
}
// Structured data embedded in prose or a fenced response is still rendered.
// The scanner only parses JSON; malformed/clipped candidates are not printed.
function embeddedValues(text, depth) {
  const marker=/(?:```(?:json|jsonl)?\s*\n)?(?:\{\s*"|\[\s*(?:\{|\[|"))/i.exec(text);
  if(!marker)return null;
  const start=marker.index, bodyStart=start+(marker[0].startsWith('```')?marker[0].indexOf('\n')+1:0);
  let nesting=0,quoted=false,escape=false,end=-1;
  for(let i=bodyStart;i<text.length;i++){
    const char=text[i];
    if(quoted){if(escape)escape=false;else if(char==='\\')escape=true;else if(char==='"')quoted=false;continue;}
    if(char==='"')quoted=true;
    else if(char==='{'||char==='[')nesting++;
    else if((char==='}'||char===']')&&--nesting===0){end=i+1;break;}
  }
  const before=text.slice(0,start).trim();
  if(end<0)return before?[before]:[];
  let parsed;
  try{parsed=JSON.parse(text.slice(bodyStart,end));}catch{return before?[before]:[];}
  const after=text.slice(end).replace(/^\s*```/, '').trim();
  return [before,displayValue(parsed,depth+1),after?displayValue(after,depth+1):null].filter(v=>v!==null && v!=='');
}
export function isOrchestration(text) {
  return typeof text==='string' && /(?:\btools\.[\w]+\s*\(|\bPromise\.all(?:Settled)?\s*\(|\b(?:text|image|notify)\s*\(\s*(?:await\b|tools\.))/.test(text);
}
export function displayValue(value, depth=0) {
  if(depth>12 || value==null)return null;
  if(typeof value==='string'){
    let text=value.trim();
    if(!text)return null;
    if(/^(?:Script (?:completed|running)|Chunk ID:|Wall time:)/.test(text)){
      const marker=/(?:Final output|Output):\s*/.exec(text);
      if(marker)text=text.slice(marker.index+marker[0].length).trim();
      else return /running/i.test(text)?'Operation still running':null;
    }
    if(!text)return null;
    try{return displayValue(JSON.parse(text),depth+1);}catch{}
    if(/^(?:\{\s*"|\[\s*(?:\{|\[|"))/.test(text)){
      const values=jsonSequence(text);
      return values?displayValue(values,depth+1):null;
    }
    // A transport prefix with a clipped JSON body is not useful prose.
    if(/"(?:chunk_id|wall_time_seconds|original_token_count)"\s*:/.test(text))return null;
    if(isOrchestration(text))return null;
    return embeddedValues(text,depth) ?? text;
  }
  if(Array.isArray(value))return value.map(item=>displayValue(item,depth+1)).filter(item=>item!==null);
  if(typeof value!=='object')return value;
  if(value.omitted || ['image','audio','base64','input_image'].includes(value.type))return null;
  if(value.status==='fulfilled' && 'value' in value)return displayValue(value.value,depth+1);
  if(value.status==='rejected')return {Error:displayValue(value.reason,depth+1) || 'Tool request failed'};
  const body=value.output ?? value.content ?? value.text;
  const envelope=Object.keys(value).every(key=>plumbing.has(key) || ['output','content','text','exit_code','exitCode','success'].includes(key));
  if(body!=null && envelope){
    const content=displayValue(body,depth+1);
    const exit=value.exit_code ?? value.exitCode;
    if(typeof exit==='number' && exit!==0)return {'Exit code':exit,Response:content};
    return value.isError || value.is_error || value.success===false ? {Error:content} : content;
  }
  const fields=Object.entries(value).flatMap(([key,item])=>{
    if(plumbing.has(key) || ((key==='exit_code'||key==='exitCode')&&item===0))return [];
    const rendered=displayValue(item,depth+1);
    return rendered===null?[]:[[key,rendered]];
  });
  return fields.length?Object.fromEntries(fields):null;
}
export function readableText(value) {
  const shown=displayValue(value);
  const walk=item=>item==null?'':Array.isArray(item)?item.map(walk).filter(Boolean).join('\n'):typeof item==='object'?Object.entries(item).map(([key,v])=>`${key.replaceAll('_',' ')}: ${walk(v)}`).join('\n'):String(item);
  return walk(shown);
}
