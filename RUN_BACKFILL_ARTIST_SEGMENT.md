# Runbook: Artist Segment Backfill (SuiteScript 2.1 Map/Reduce)

This runbook walks you through safely deploying and running `backfill_artist_segment_mr.js` to backfill an **Artist custom segment** on historical transactions **only when the target field is empty**.

## What the script does (high level)

- **Derives** an `artistKey` by parsing **Project: Name (Grouped)** (your saved report’s “Project” column, typically sourced from `job` or `class` text) using a delimiter (default `:`) and token index (default `1`).
- **Maps** that `artistKey` to a **custom segment value internal ID** (via overrides JSON first, otherwise via a search on the segment value record type).
- **Updates**:
  - **Header** artist field (optional) only if currently empty
  - **Line** artist field (optional) only if currently empty (scans sublists like `item,expense`)
- **Dry run** mode logs what would change and saves nothing.

## Prereqs you should know

- You know your **Artist segment value record type** (example pattern: `customrecord_cseg_artist`).
- You know which field(s) you want to populate:
  - Header Artist field internal ID (example: `cseg2` or `custbody_cseg2`)
  - Line Artist field internal ID (example: `custcolcseg2`)
- You know where “Project” lives:
  - Common header field: `job` (and sometimes `class`)
  - Line “project” field varies by sublist/account; you must supply its internal ID if doing line mode.

## Step 1: Upload script

1. NetSuite → **Customization → Scripting → Scripts → New**
2. Choose **Map/Reduce Script**
3. Upload `backfill_artist_segment_mr.js`
4. Save (creates the Script record)

## Step 2: Create a deployment

1. From the Script record, click **Deploy Script**
2. Set **Status** to **Testing** for initial runs
3. Save

## Step 3 (recommended): Create a small input Saved Search

This is the safest way to start.

Create a **Transaction** saved search (or whatever your account uses to return transaction results) with a small scope (ex: one subsidiary + a short date range).

Suggested filters:
- **Main Line** = `T`
- **Job/Project** is not empty (or your equivalent)
- (If targeting header field) **Artist segment field** is empty

If you are matching your **line-grouped** report (columns: **Project: Name (Grouped)** and **Artist**), use **line mode**:\n+- Ensure your search returns transactions that have a line-level project value (often stored in the line `class` or line `job`).\n+- Filter where **Artist (line)** is empty (your Artist segment field ID is `cseg2`, commonly exposed on lines as `custcolcseg2`).\n+\n+Note: the script still only updates **when Artist is empty**; existing Artist values are never overwritten.

Copy the saved search **Internal ID** (not the script ID).

## Step 4: Configure deployment parameters

Set parameters on the **Deployment → Parameters** tab.

### Core parameters (most important)

- **Dry run**: `custscript_artist_backfill_dry_run`
  - First run: `true`
  - Real update: `false`

- **Input Saved Search** (recommended): `custscript_artist_backfill_savedsearch`
  - Put your saved search internal ID here.
  - If blank, the script uses a built-in default transaction search.

- **Segment value record type** (required unless you fully use overrides): `custscript_artist_backfill_segval_rectype`
  - Example pattern: `customrecord_cseg_artist`

### Target fields (set what you need)

- **Header Artist field internal ID** (optional): `custscript_artist_backfill_header_field`
  - Only set if you want header-level updates.

- **Line Artist field internal ID** (optional): `custscript_artist_backfill_line_field`
  - Only set if you want line-level updates.

- **Line Project field internal ID** (optional, required for line mode): `custscript_artist_backfill_line_project_field`
  - Required if you set `line_field`.

- **Sublists to scan** (line mode): `custscript_artist_backfill_sublists`
  - Default: `item,expense`

### Parsing (how artistKey is extracted from project name)

- **Delimiter**: `custscript_artist_backfill_delim`
  - Default: `:`

- **Token index**: `custscript_artist_backfill_token_index`
  - Default: `1` (second token)
  - Example project: `Label:Drake:2024`
    - Delimiter `:` + token index `1` → `Drake`

### Overrides (optional but recommended for edge cases)

- **Overrides JSON**: `custscript_artist_backfill_overrides_json`
  - Maps parsed `artistKey` → segment value internal ID

Example:

```json
{
  "Drake": "123",
  "The Weeknd": "456"
}
```

## Step 5: Execute a dry run

1. Ensure **Dry run** = `true`
2. Save the deployment
3. Click **Execute** (or **Schedule** / **Run** depending on your UI)

## Step 6: Verify the logs

In the script execution log, look for these **Audit** entries:

- **Dry run - would update**
  - Means the script found a segment value ID and would have saved changes

- **No changes**
  - Means nothing to update (already filled, could not derive a match, or line mode not configured)

Watch for **Error** entries:
- **Ambiguous Artist match**
  - Multiple segment values matched the artistKey; record is skipped. Fix by tightening names or using overrides JSON.
- **Invalid overrides JSON**
  - Overrides JSON didn’t parse; fix formatting.
- **Reduce error**
  - Often permissions, record load issues, or wrong recordType; inspect details in the error payload.

## Step 7: Run a small real update

1. Set **Dry run** = `false`
2. Keep the same small saved search
3. Execute again
4. Confirm updated transactions now show the Artist segment value (header and/or lines depending on what you configured)

## Step 8: Scale up gradually

- Expand your saved search scope (date range, transaction types, subsidiaries) incrementally.
- Keep monitoring summarize stats and error logs.

## If you do NOT use a saved search (default input mode)

If `custscript_artist_backfill_savedsearch` is blank, the script builds a default transaction search that:

- Filters `mainline = T`
- Requires `job` not empty
- Optionally filters transaction **type** using:
  - `custscript_artist_backfill_trantypes` (CSV like `VendBill,Journal,CustInvc`)
- If `custscript_artist_backfill_header_field` is set, it filters to only those where that field is empty.

## Troubleshooting quick hits

- **Dry run shows only “No changes”**
  - Verify `custscript_artist_backfill_segval_rectype` is correct.
  - Verify your parsed `artistKey` exactly matches the segment value **Name** (or add an override).
  - If your project name doesn’t contain the delimiter, the script falls back to the full name; adjust delimiter/index accordingly.

- **Header is not updating**
  - Ensure `custscript_artist_backfill_header_field` is set to the correct internal ID and the field is actually empty on target transactions.

- **Lines are not updating**
  - You must set BOTH `custscript_artist_backfill_line_field` and `custscript_artist_backfill_line_project_field`.
  - Ensure the project field exists on the sublists you scan (`item`, `expense`, etc.).

- **Ambiguous Artist match**
  - Two segment values match your key (especially with the `contains` fallback). Use overrides JSON to force a specific internal ID.

