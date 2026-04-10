# Artist Segment Backfill (SuiteScript 2.1 Map/Reduce)

This Map/Reduce script fills **Artist custom segment** values on historical transactions **only where the field is empty**, deriving the artist from the related **Project name** (parsed using `:` or another delimiter).

## What you configure (script parameters)

- **Dry run** (`custscript_artist_backfill_dry_run`)
  - `true` (recommended first): logs what would change, saves nothing
  - `false`: performs updates

- **Input Saved Search (optional)** (`custscript_artist_backfill_savedsearch`)
  - If provided, the script uses `search.load()`
  - If empty, the script builds a default `transaction` search

- **Transaction types CSV (default search only)** (`custscript_artist_backfill_trantypes`)
  - Comma-separated `type` values used by NetSuite transaction searches (example: `VendBill,Journal,CustInvc`)

- **Header Artist field internal ID (optional)** (`custscript_artist_backfill_header_field`)
  - Example: `cseg2` (your Artist segment) or `custbody_cseg2` depending on how your segment is exposed
  - If set, header Artist is populated only if currently empty

- **Line Artist field internal ID (optional)** (`custscript_artist_backfill_line_field`)
  - Example: `cseg2` or `custcolcseg2` (your report shows `tcfd_custcolcseg2`)

- **Line Project field internal ID (optional)** (`custscript_artist_backfill_line_project_field`)
  - Example: `job` (varies by transaction/sublist). This script uses the field’s **text** when available.

- **Header Project field internal ID (optional)** (`custscript_artist_backfill_header_project_field`)
  - Use this if your “project” is not stored in `job`
  - Common alternatives: `class` (some accounts use Class as Project/Job in reporting)

- **Sublists to scan (line mode)** (`custscript_artist_backfill_sublists`)
  - CSV list, default `item,expense`

## Parsing settings

- **Project name source (default search / map hints)** (`custscript_artist_backfill_project_source`)
  - Default: `job.entityid`
  - Also commonly useful: `job.companyname`

- **Delimiter** (`custscript_artist_backfill_delim`)
  - Default: `:`

- **Token index** (`custscript_artist_backfill_token_index`)
  - Default: `1` (second token, typical `Prefix:Artist:...`)
  - Example:
    - Project name `Label:Drake:2024`
    - With token index `1` → `Drake`

## Segment value lookup (required unless using overrides)

To set a custom segment value, the script must map `artistKey` → the segment value’s internal ID.

You provide:

- **Segment value record type** (`custscript_artist_backfill_segval_rectype`)
  - For a custom segment with ID like `cseg_artist`, the value record type is commonly `customrecord_cseg_artist`.

- **Name field** (`custscript_artist_backfill_segval_namefield`)
  - Default: `name`

- **ID field** (`custscript_artist_backfill_segval_idfield`)
  - Default: `internalid`

Lookup strategy:
- Exact match on `name`
- If not found, `contains` match
- If multiple matches: logs an “Ambiguous Artist match” error and skips

## Overrides (optional)

- **Overrides JSON** (`custscript_artist_backfill_overrides_json`)
  - JSON object mapping parsed keys to a segment value internal ID
  - Example:

```json
{
  "Drake": "123",
  "The Weeknd": "456"
}
```

Overrides are checked first. If present for a key, the script uses that value without searching.

## How to find internal IDs quickly

- **Artist segment ID / value record type**
  - `Customization → Lists, Records, & Fields → Custom Segments`
  - Open the Artist segment and note:
    - **Script ID** (often `cseg_artist`)
    - The segment’s **Value record** script ID (commonly `customrecord_<segment_script_id>`)

- **Transaction field IDs**
  - On a transaction form, use **Customize Form** / field help to locate the internal ID
  - Or check field IDs in the segment configuration / applied-to record types

## Safety notes

- The script only sets fields **when they are empty**
- Run **dry run** first and validate the audit log output
- Start with a small saved search (date range, specific subsidiaries/projects) before scaling up

