# Canvas Library Licensing

Checked 2026-11-01 against tldraw.dev (pricing, /community/license, /sdk-features/license-key,
/get-a-license/hobby, /releases). The full license text at /legal/tldraw-license returned 404,
so the exact redistribution clauses are not verified.

## tldraw (current major: v5.x)

- **Development only by default.** "Under its default terms, the tldraw SDK license permits use
  only in development." Production use needs a trial, hobby, or commercial license key.
- **No key in production means no editor.** "Without one, the SDK logs errors to the console and,
  after five seconds, stops rendering the editor." There is no watermark-only fallback.
  Production is defined as "HTTPS on a non-loopback domain with NODE_ENV=production". The docs do
  not say how a VS Code webview (`vscode-webview://`) is treated. Relying on that gap would still
  break the license, which permits use only in development.
- **Keys are tied to domains.** Downstream users "will require their own trial, commercial, or
  hobby license in order to use the SDK in production."
- **Free tiers:**
  - _Trial:_ 100 days, one per project, no watermark. It is for evaluation and stops working
    immediately when it expires.
  - _Hobby:_ discretionary and reviewed by hand. It covers non-commercial projects and requires a
    "made with tldraw" watermark. Keys are domain-bound, which suits a marketplace extension poorly.
  - _Commercial:_ paid, priced by value.
- **Not open source.** The SDK is "source available, it is not permissively licensed". tldraw's
  trademark guidelines also limit use of the name. That affects the `tldraw` keyword and the README.

**Conclusion:** tldraw's terms block free, unrestricted distribution of Agentic Whiteboard.

## Excalidraw (MIT)

`@excalidraw/excalidraw` is MIT licensed. It needs no key, has no watermark, and allows
redistribution. It supports custom element data (`customData`), bound arrows, frames, and
PNG/SVG export (`exportToBlob` / `exportToSvg`). It does not have tldraw-style custom shape
classes, so plan shapes are drawn as styled element groups tagged with `customData`.

## Decision

Agentic Whiteboard uses neither tldraw nor Excalidraw. Its canvas is written from scratch in React and
SVG (`packages/webview/src/canvas`). Pen strokes use perfect-freehand (MIT) and the hand-drawn
style uses rough.js (MIT). The canvas sits behind the `CanvasAdapter` interface
(`canvas/types.ts`), and the plan JSON is library-neutral, so you could swap in another canvas
later without migrating any data.

The tldraw name is not used in the extension's keywords or marketing.

## What ships, and under which license

Agentic Whiteboard itself is MIT. The bundles are minified, so third-party license texts ship in
`ThirdPartyNotices.txt` next to each bundle (generated from esbuild metafiles by
`scripts/notices.mjs`). Highlights:

| Package                                     | License                                                   | Where                      |
| ------------------------------------------- | --------------------------------------------------------- | -------------------------- |
| react, react-dom, scheduler                 | MIT                                                       | webview                    |
| roughjs, perfect-freehand                   | MIT                                                       | webview                    |
| zod                                         | MIT                                                       | all                        |
| elkjs                                       | EPL-2.0 OR GPL-3.0-or-later (we use it under **EPL-2.0**) | extension host, MCP server |
| @modelcontextprotocol/sdk, ajv, ajv-formats | MIT                                                       | MCP server                 |
| fast-uri                                    | BSD-3-Clause                                              | MCP server                 |
| zod-to-json-schema                          | ISC                                                       | MCP server                 |
| jsonc-parser                                | MIT                                                       | extension host             |

elkjs is redistributed unmodified. EPL-2.0 is file-level copyleft: it allows distribution in an
MIT-licensed product as long as the elkjs license notice is kept (it is, in
`ThirdPartyNotices.txt`) and its source is available (at https://github.com/kieler/elkjs).
