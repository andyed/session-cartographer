# cartographer-common.sh — source hooks/common.sh into a script in scripts/.
#
#   . "$(dirname "$0")/cartographer-common.sh" 2>/dev/null \
#     || cartographer_append() { printf '%s\n' "$2" >> "$1"; }
#
# scripts/ sits in two layouts: the repository root, where the hooks live
# under plugins/session-cartographer/, and the assembled plugin, where they are
# a sibling (copy-plugin-runtime.sh builds the second). The writers here need
# cartographer_append, the one-write JSONL append, from the same definition
# the hooks use. A script copied out on its own (some tests do) finds neither,
# and the fallback in the line above appends as scripts did before: whole rows
# under 1 KB, no guarantee past it.
_carto_common_here=$(cd "${BASH_SOURCE[0]%/*}" 2>/dev/null && pwd -P)
for _carto_common in \
  "$_carto_common_here/../hooks/common.sh" \
  "$_carto_common_here/../plugins/session-cartographer/hooks/common.sh"
do
  if [ -f "$_carto_common" ]; then
    # shellcheck source=/dev/null
    . "$_carto_common"
    break
  fi
done
unset _carto_common _carto_common_here
declare -F cartographer_append >/dev/null 2>&1
