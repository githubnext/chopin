# OpenUI comparison composition contract

An ordinary document may contain one or more `openui-options` fences. Each fence
stores authored source in the document. Its rendered section helps readers compare
options; it does not create a decision or save a choice. The source, view order,
and option data persist. The filter and expanded details belong to each reader
and reset on reload.

## Authoring syntax

Use one declaration per line, with no blank lines, comments, expressions, state,
queries, mutations, or arbitrary components. All text is a JSON-style quoted
string on one physical line; use `\n` inside a string for a line break. Declare
the `root`, three views, `option1` through `optionN`, and `media1` through
`mediaN`, in any declaration order. `N` is 2–6. Each option references its
matching media declaration. Every view references each option exactly once,
and the root references the three views exactly once. Reordering those lists
changes the authored reading order.

| Component          | Arguments, in order                                                              |
| ------------------ | -------------------------------------------------------------------------------- |
| `OptionsSection`   | title, introduction, `[gallery, comparison, details]` in any order               |
| `OptionGallery`    | title, `"grid"` or `"rail"`, all option references in any order                  |
| `OptionComparison` | title, all option references in any order                                        |
| `OptionDetails`    | title, all option references in any order                                        |
| `DesignOption`     | unique id, title, strength, tradeoff, detail, category, matching media reference |
| `OptionImage`      | absolute HTTPS image URL, descriptive alt text, caption or attribution           |
| `OptionPreview`    | plain-text preview, caption or provenance label                                  |

Ids use 1–24 lowercase ASCII letters, digits, or hyphens. Titles use 1–90
characters for the section and 1–70 elsewhere. Introduction uses 1–240;
strength and tradeoff 1–180 each; detail 1–500; category 1–32; image alt
1–180; preview text 1–240; media caption 1–100. An image URL is at most 2,048
characters and follows the document's HTTPS-only image URL rule, with no
whitespace or hidden characters. The complete fence is at most 12,000 characters and
contains at most six images. The category powers a private filter; it is not a
saved answer. Preview text is rendered as text, never HTML or executable code.

### Public-source example: proposed pandas Excel styling

This adapts [pandas issue #54154](https://github.com/pandas-dev/pandas/issues/54154)
at the trial's 16 July 2023 checkpoint. The image shows current output. The
plain alternative is a proposal, not a recorded decision or measured result.

````md
```openui-options
root = OptionsSection("Excel header styling", "Compare the current output with a proposed plain default.", [gallery, comparison, details])
gallery = OptionGallery("Outputs", "grid", [option1, option2])
comparison = OptionComparison("Tradeoffs", [option1, option2])
details = OptionDetails("Source reasoning", [option1, option2])
option1 = DesignOption("current", "Keep current default", "Preserves styled headers", "Basic exports retain formatting", "The issue shows bold and bordered headers in the current output.", "Current", media1)
media1 = OptionImage("https://user-images.githubusercontent.com/24256554/208918872-c616b449-b399-42e6-8a03-b3581063857a.png", "Spreadsheet with styled row and column headers", "Current output shown in pandas issue #54154")
option2 = DesignOption("plain", "Plain default", "Would produce unstyled basic exports", "Changes existing default output", "The issue proposes removing default header styling and using Styler for deliberate formatting.", "Proposal", media2)
media2 = OptionPreview("A  B\n1  2", "Illustrative reconstruction; not a source screenshot")
```
````

### Synthetic example: comparison first

This invented API example shows a different content set and a different view
order. It is a layout fixture, not repository evidence.

````md
```openui-options
root = OptionsSection("Pagination choices", "Illustrative API alternatives.", [comparison, details, gallery])
gallery = OptionGallery("Response shapes", "rail", [option2, option1, option3])
comparison = OptionComparison("Tradeoffs", [option1, option2, option3])
details = OptionDetails("How each works", [option1, option2, option3])
option1 = DesignOption("offset", "Offset", "Simple page numbers", "Deep pages can be costly", "A client sends an offset and limit.", "Simple", media1)
media1 = OptionPreview("GET /items?offset=20&limit=10", "Synthetic request")
option2 = DesignOption("cursor", "Cursor", "Stable continuation", "Opaque navigation", "A client sends the cursor from the prior response.", "Stable", media2)
media2 = OptionPreview("GET /items?after=eyJpZCI6MjB9", "Synthetic request")
option3 = DesignOption("keyset", "Keyset", "Efficient ordered scan", "Needs a stable sort key", "A client sends the last sort key it observed.", "Stable", media3)
media3 = OptionPreview("GET /items?after_id=20", "Synthetic request")
```
````

## Validation and recovery

The editor validates the complete source before rendering. It reports one of:
missing or oversized source; unsupported declaration or component; missing,
duplicate, or mismatched references; invalid field or image URL; OpenUI parse
failure; or unsupported runtime statements. The editable source and neighboring
prose remain intact after an error. A valid edit restores the preview. The
renderer loads only when a document contains this fence.

OpenUI is pinned to `@openuidev/react-lang@0.3.0`. Vite selects that package's
published `react-native` conditional entry for this one dependency because its
web entry starts development tools from a CDN. The selected entry exposes the
same API in this version, but upstream documents it for React Native rather
than web use. The adapter checks the installed version and export shape; an
upgrade needs an entry/API review and development network check.

Building the starting commit `37b4efdd` and this feature with Bun 1.4.2
measured all emitted JavaScript at 16,321,335 → 16,454,457 bytes raw
(**+133,122**) and 3,676,855 → 3,717,928 bytes gzip (**+41,073**). CSS grew
3,492 raw / 955 gzip bytes. Initial JavaScript stayed 251,015 bytes raw and
changed 79,206 → 79,198 bytes gzip. The lazy `openui-options` chunk itself is
126,895 raw / 38,739 gzip bytes, including runtime and component code; it is
not the full-build delta.

The first product slice supports one comparison composition with images or
text previews, a table, expandable details, and a per-reader category filter.
It does not provide a gallery builder, generated executable UI, saved decisions,
new chart types, app preview publishing, or MCP controls.

## Planner handoff

When a document would benefit from comparing 2–6 concrete alternatives, write
one `openui-options` fence using this exact vocabulary. Ground option claims in
available source; label proposals, illustrations, and measurements accurately.
Use `OptionImage` only for a known, safe HTTPS image with meaningful alt text;
otherwise use `OptionPreview` and label synthetic content. Keep one declaration
per line, include all three views, reuse the same options in every view, and do
not add a choice control or imply that filtering records a decision. If the
source does not establish alternatives, use ordinary prose instead.
