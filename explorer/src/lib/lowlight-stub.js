// Stand-in for `lowlight`, aliased in vite.config.js. @git-diff-view/core
// imports its highlighter statically, and the real module registers every
// highlight.js grammar up front: measured at 1,115 kB (340 kB gzipped) in the
// SplitDiff chunk against 389 kB for the whole Explorer entry; with this stub
// the chunk is 157 kB (40 kB gzipped). The split view
// renders with syntax colouring off, since token colours are where the
// library's palette falls under the 8:1 reading floor, so nothing here is ever
// asked to highlight. Every method the wrapper calls answers "no grammar".
const empty = () => ({ type: 'root', children: [] });

export function createLowlight() {
  return {
    highlight: empty,
    highlightAuto: empty,
    register() {},
    registerAlias() {},
    registered: () => false,
    listLanguages: () => [],
  };
}

export const all = {};
export const common = {};
