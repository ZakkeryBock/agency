# GUI

## What it does
<!-- agency:ai -->
Vanilla DOM + cytoscape (map), CodeMirror 6 (source editor), marked + DOMPurify (rendering), turndown (rich mode back to markdown), mermaid loaded lazily.
<!-- /agency:ai -->

## Notes

## Gotchas
<!-- agency:ai -->
Rich mode converts HTML back to markdown, so unusual markdown can be normalized on save. AI blocks are read-only there to keep them lossless.
Map uses a top-down breadth-first layout once; after that new nodes are placed next to neighbors so your arrangement survives.
<!-- /agency:ai -->
