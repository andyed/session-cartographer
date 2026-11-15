# carto-flow

The pane, the drawing and the classifier in `hooks/` are forked from
[lot-map](https://github.com/alexeyw/lot-map) 0.6.0 by Aleksei Volodin, MIT
licensed. Its licence text is kept beside this file as `LICENSE-lot-map`.

It began as a mod of its own, carto-flow, and now ships inside the Session
Cartographer plugin as one of its hooks modules; the plugin's `flowMap` option
switches it off.

Changed here: the mod's name, the defaults that send Session Cartographer's
recall to the Memory station, and a list of the pages a session visited, opened
from a row of station buttons under the map.

On the desktop, editor and mobile surfaces the pane no longer draws lot-map's
hub. It draws the hub and the ribbon of the Explorer's session map, from
byte-identical copies of that code in `hooks/flowmap/` (kept in step by
`scripts/sync-carto-flow-flowmap.sh` in the repository). That
drawing is Session Cartographer's own; its ring of stations and their glyphs
began as lot-map's. A terminal, and a person who sets the light theme, still get
lot-map's rows and picture.

Also changed off a terminal: under the new hub there is no row of station
buttons (the hub names its stations) and so no list of pages by station; a row of
the feed links to the page it went to, or to the Explorer's review of the file it
changed; one link to the Explorer is the last thing in the pane; nothing is
dimmed; and the light palette's two text greys are darker than lot-map's
(`hooks/palette.ts`).

While Session Cartographer's Explorer answers on its port, the station's name at
the head of each row of the feed is a link to that station on the session's map
there, and the mod asks the Explorer for its health at most once a minute to
know. With no Explorer there is no link to it anywhere in the pane.

Under the new hub the ribbon is drawn in slots, a slot a run of calls at one
station, with a control under each: pressing it narrows the feed to that
station, and pressing it again gives the whole feed back.
