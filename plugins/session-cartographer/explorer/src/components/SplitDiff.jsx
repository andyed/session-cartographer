import { useMemo } from 'react';
import { DiffFile, DiffModeEnum, DiffView } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import '../styles/split-diff.css';

// Loaded lazily from MemoryArtifact: the renderer carries highlight.js, which
// no other Explorer view needs, so it must not sit in the entry chunk.
const LANG_BY_EXT = { md: 'markdown', markdown: 'markdown', mdown: 'markdown', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', css: 'css', html: 'html', sh: 'bash', bash: 'bash', zsh: 'bash', py: 'python', yml: 'yaml', yaml: 'yaml', toml: 'toml', awk: 'awk', sql: 'sql', swift: 'swift', rs: 'rust', go: 'go' };

export function fileLang(name = '') {
  const ext = String(name).toLowerCase().split('.').pop();
  return LANG_BY_EXT[ext] || 'plaintext';
}

export default function SplitDiff({ name, diff, range, layout = 'split' }) {
  const lang = fileLang(name);
  const prose = lang === 'markdown';
  const file = useMemo(() => {
    // git already computed the hunks server-side; the two full texts only let
    // the viewer expand collapsed context without another round trip.
    const instance = DiffFile.createInstance({
      oldFile: { fileName: name, fileLang: lang, content: range?.oldContent ?? '' },
      newFile: { fileName: name, fileLang: lang, content: range?.newContent ?? '' },
      hunks: [diff],
    });
    instance.initTheme('dark');
    instance.init();
    instance.buildSplitDiffLines();
    instance.buildUnifiedDiffLines();
    return instance;
  }, [name, lang, diff, range?.oldContent, range?.newContent]);
  return <div className="memory-split-diff" role="region" aria-label={layout === 'split' ? 'Side-by-side diff' : 'Unified diff'} tabIndex={0}>
    <DiffView
      diffFile={file}
      diffViewMode={layout === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified}
      diffViewTheme="dark"
      // Token colouring is where the library's palette falls below the 8:1
      // reading floor; changed text is the signal here, not syntax.
      diffViewHighlight={false}
      diffViewWrap={prose}
      diffViewFontSize={15}
    />
  </div>;
}
