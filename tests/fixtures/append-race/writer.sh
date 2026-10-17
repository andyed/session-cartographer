#!/bin/bash
# writer.sh <common.sh> <char> <count> <file> <mode> <size>...
#
# One of the racing writers in tests/unit/jsonl-append-concurrency.test.js.
# Row i is exactly the (i mod n)th size in bytes before its newline, padded
# with <char>, so a row that comes back any other length or with a foreign
# byte in it was torn. mode "helper" appends with cartographer_append, mode
# "printf" the way the hooks did before it. Spins on <file>.go so every writer
# starts at once.
. "$1"; c=$2; count=$3; f=$4; mode=$5; shift 5
sizes=("$@"); n=${#sizes[@]}
src=$(printf '%*s' 13000 '' | tr ' ' "$c")
while [ ! -e "$f.go" ]; do :; done
i=0
while [ $i -lt "$count" ]; do
  size=${sizes[$((i % n))]}
  head="{\"w\":\"$c\",\"i\":$i,\"pad\":\""
  pad=${src:0:$((size - ${#head} - 2))}
  row="$head$pad\"}"
  if [ "$mode" = helper ]; then cartographer_append "$f" "$row"; else printf '%s\n' "$row" >> "$f"; fi
  i=$((i + 1))
done
