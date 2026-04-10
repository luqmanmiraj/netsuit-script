/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/runtime', 'N/search', 'N/record', 'N/log'], (runtime, search, record, log) => {
  const PARAM = {
    dryRun: 'custscript_artist_backfill_dry_run',
    savedSearchId: 'custscript_artist_backfill_savedsearch',
    transactionTypesCsv: 'custscript_artist_backfill_trantypes',
    headerArtistFieldId: 'custscript_artist_backfill_header_field',
    segmentValueRecordType: 'custscript_artist_backfill_segval_rectype',
    segmentValueNameFieldId: 'custscript_artist_backfill_segval_namefield',
    segmentValueIdFieldId: 'custscript_artist_backfill_segval_idfield',
    projectNameSource: 'custscript_artist_backfill_project_source',
    delimiter: 'custscript_artist_backfill_delim',
    tokenIndex: 'custscript_artist_backfill_token_index',
    sublistsCsv: 'custscript_artist_backfill_sublists',
    lineArtistFieldId: 'custscript_artist_backfill_line_field',
    lineProjectFieldId: 'custscript_artist_backfill_line_project_field',
    artistOverridesJson: 'custscript_artist_backfill_overrides_json',
    headerProjectFieldId: 'custscript_artist_backfill_header_project_field',
  };

  const SEGMENT_VALUE_CACHE = Object.create(null); // artistKey -> segmentValueInternalId | null
  let ARTIST_OVERRIDES = null; // lazy init

  function getParam(name) {
    return runtime.getCurrentScript().getParameter({ name });
  }

  function getBooleanParam(name, defaultValue) {
    const raw = getParam(name);
    if (raw === true || raw === 'T' || raw === 'true') return true;
    if (raw === false || raw === 'F' || raw === 'false') return false;
    return Boolean(defaultValue);
  }

  function toCsvList(raw) {
    if (!raw) return [];
    return String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function normalizeArtistKey(s) {
    if (!s) return '';
    return String(s).trim().replace(/\s+/g, ' ');
  }

  function parseArtistKeyFromProjectName(projectName) {
    const delim = (getParam(PARAM.delimiter) || ':').toString();
    const idxRaw = getParam(PARAM.tokenIndex);
    const idx = Number.isFinite(Number(idxRaw)) ? Number(idxRaw) : 1; // default: second token (common "Prefix:Artist:...")

    const name = String(projectName || '').trim();
    if (!name) return '';

    const parts = name.split(delim).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return '';

    // If delimiter not present (parts.length === 1), fall back to the whole name.
    const candidate = parts[idx] ?? parts[0];
    return normalizeArtistKey(candidate);
  }

  function loadArtistOverrides() {
    if (ARTIST_OVERRIDES) return ARTIST_OVERRIDES;
    const raw = getParam(PARAM.artistOverridesJson);
    if (!raw) {
      ARTIST_OVERRIDES = Object.create(null);
      return ARTIST_OVERRIDES;
    }
    try {
      const parsed = JSON.parse(String(raw));
      ARTIST_OVERRIDES = parsed && typeof parsed === 'object' ? parsed : Object.create(null);
      return ARTIST_OVERRIDES;
    } catch (e) {
      log.error({ title: 'Invalid overrides JSON', details: e });
      ARTIST_OVERRIDES = Object.create(null);
      return ARTIST_OVERRIDES;
    }
  }

  function getSegmentValueInternalIdForArtistKey(artistKey) {
    const key = normalizeArtistKey(artistKey);
    if (!key) return null;
    if (Object.prototype.hasOwnProperty.call(SEGMENT_VALUE_CACHE, key)) return SEGMENT_VALUE_CACHE[key];

    const overrides = loadArtistOverrides();
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, key)) {
      const overridden = overrides[key];
      SEGMENT_VALUE_CACHE[key] = overridden ? String(overridden) : null;
      return SEGMENT_VALUE_CACHE[key];
    }

    const rectype = getParam(PARAM.segmentValueRecordType);
    if (!rectype) {
      SEGMENT_VALUE_CACHE[key] = null;
      return null;
    }

    const nameField = (getParam(PARAM.segmentValueNameFieldId) || 'name').toString();
    const idField = (getParam(PARAM.segmentValueIdFieldId) || 'internalid').toString();

    // Try exact match first, then "contains" fallback.
    const tryFilters = [
      [[nameField, 'is', key]],
      [[nameField, 'contains', key]],
    ];

    for (let i = 0; i < tryFilters.length; i += 1) {
      const s = search.create({
        type: String(rectype),
        filters: tryFilters[i],
        columns: [idField, nameField],
      });

      const r = s.run().getRange({ start: 0, end: 2 }) || [];
      if (r.length === 1) {
        const id = r[0].getValue({ name: idField });
        SEGMENT_VALUE_CACHE[key] = id ? String(id) : null;
        return SEGMENT_VALUE_CACHE[key];
      }
      if (r.length > 1) {
        log.error({
          title: 'Ambiguous Artist match',
          details: `artistKey="${key}" matched multiple segment values in ${rectype} using filter ${JSON.stringify(tryFilters[i])}`,
        });
        SEGMENT_VALUE_CACHE[key] = null;
        return null;
      }
    }

    SEGMENT_VALUE_CACHE[key] = null;
    return null;
  }

  function getProjectNameFromResult(result) {
    const source = (getParam(PARAM.projectNameSource) || 'job.entityid').toString();
    const [join, field] = source.includes('.') ? source.split('.', 2) : [null, source];
    const opts = join ? { name: field, join } : { name: field };
    return result.getValue(opts) || result.getText(opts) || '';
  }

  function buildDefaultSearch() {
    const types = toCsvList(getParam(PARAM.transactionTypesCsv));
    const headerArtistFieldId = getParam(PARAM.headerArtistFieldId);

    const filters = [];
    if (types.length) filters.push(['type', 'anyof', types]);
    filters.push('AND', ['mainline', 'is', 'T']);
    filters.push('AND', ['job', 'noneof', '@NONE@']);
    if (headerArtistFieldId) filters.push('AND', [String(headerArtistFieldId), 'anyof', '@NONE@']);

    return search.create({
      type: search.Type.TRANSACTION,
      filters,
      columns: [
        search.createColumn({ name: 'internalid' }),
        search.createColumn({ name: 'recordtype' }),
        search.createColumn({ name: 'type' }),
        search.createColumn({ name: 'job' }),
        search.createColumn({ name: 'entityid', join: 'job' }),
        search.createColumn({ name: 'companyname', join: 'job' }),
      ],
    });
  }

  function getInputData() {
    const savedSearchId = getParam(PARAM.savedSearchId);
    if (savedSearchId) return search.load({ id: String(savedSearchId) });
    return buildDefaultSearch();
  }

  function pickSearchValue(v) {
    // Saved search JSON values vary by column type:
    // - string/number
    // - { value, text }
    // - [{ value, text }, ...]
    if (v == null) return '';
    if (Array.isArray(v)) {
      const first = v[0];
      if (first && typeof first === 'object') return first.text || first.value || '';
      return first != null ? String(first) : '';
    }
    if (typeof v === 'object') return v.text || v.value || '';
    return String(v);
  }

  function map(context) {
    const row = JSON.parse(context.value);
    const internalId = row.id || (row.values && row.values.internalid && row.values.internalid.value);
    const recordType = row.recordType || (row.values && row.values.recordtype);
    const projectName = (() => {
      // For your line-grouped report, “Project: Name (Grouped)” is the source.
      // In practice, it commonly comes from `class` or `job` columns in the saved search.
      const v = row.values || {};
      const sourceKey = (getParam(PARAM.projectNameSource) || 'job.entityid').toString();

      // 1) Respect configured source key (e.g., "class", "job", "job.entityid", "job.companyname")
      const direct = pickSearchValue(v[sourceKey]);
      if (direct) return direct;

      // 2) If source was join.field, also try the bare field key
      if (sourceKey.includes('.')) {
        const bare = sourceKey.split('.', 2)[1];
        const alt = pickSearchValue(v[bare]);
        if (alt) return alt;
      }

      // 3) Common fallbacks present in many transaction searches
      return (
        pickSearchValue(v['class']) ||
        pickSearchValue(v['job']) ||
        pickSearchValue(v['job.entityid']) ||
        pickSearchValue(v['job.companyname']) ||
        ''
      );
    })();

    context.write({
      key: String(internalId),
      value: JSON.stringify({
        id: String(internalId),
        recordType: recordType ? String(recordType) : null,
        projectName,
      }),
    });
  }

  function trySetHeaderArtist(tranRec, headerArtistFieldId, segmentValueInternalId) {
    if (!headerArtistFieldId) return false;
    const current = tranRec.getValue({ fieldId: String(headerArtistFieldId) });
    if (current) return false;
    tranRec.setValue({ fieldId: String(headerArtistFieldId), value: segmentValueInternalId });
    return true;
  }

  function trySetLineArtist(tranRec, sublistId, lineArtistFieldId, lineProjectFieldId) {
    if (!sublistId || !lineArtistFieldId || !lineProjectFieldId) return { updated: 0, skipped: 0 };

    let updated = 0;
    let skipped = 0;
    const count = tranRec.getLineCount({ sublistId });
    for (let i = 0; i < count; i += 1) {
      const curArtist = tranRec.getSublistValue({ sublistId, fieldId: String(lineArtistFieldId), line: i });
      if (curArtist) {
        skipped += 1;
        continue;
      }

      const projText =
        tranRec.getSublistText({ sublistId, fieldId: String(lineProjectFieldId), line: i }) ||
        tranRec.getSublistValue({ sublistId, fieldId: String(lineProjectFieldId), line: i }) ||
        '';
      const artistKey = parseArtistKeyFromProjectName(projText);
      const segValId = getSegmentValueInternalIdForArtistKey(artistKey);
      if (!segValId) {
        skipped += 1;
        continue;
      }

      tranRec.setSublistValue({ sublistId, fieldId: String(lineArtistFieldId), line: i, value: segValId });
      updated += 1;
    }

    return { updated, skipped };
  }

  function reduce(context) {
    const dryRun = getBooleanParam(PARAM.dryRun, true);
    const headerArtistFieldId = getParam(PARAM.headerArtistFieldId);
    const sublists = toCsvList(getParam(PARAM.sublistsCsv) || 'item,expense');
    const lineArtistFieldId = getParam(PARAM.lineArtistFieldId);
    const lineProjectFieldId = getParam(PARAM.lineProjectFieldId);

    const payload = JSON.parse(context.values[0]);
    const tranId = String(context.key);
    let recordType = payload.recordType;

    try {
      if (!recordType) {
        const lookup = search.lookupFields({
          type: search.Type.TRANSACTION,
          id: tranId,
          columns: ['recordtype'],
        });
        recordType = lookup && lookup.recordtype ? String(lookup.recordtype) : null;
      }

      if (!recordType) {
        log.error({ title: 'Missing recordtype', details: `internalid=${tranId}` });
        return;
      }

      const tranRec = record.load({ type: recordType, id: tranId, isDynamic: false });

      let projectName = payload.projectName || '';
      if (!projectName) {
        // If the input was a saved search without project columns, derive from the loaded record.
        try {
          const headerProjectFieldId = (getParam(PARAM.headerProjectFieldId) || '').toString().trim();
          if (headerProjectFieldId) {
            projectName = tranRec.getText({ fieldId: headerProjectFieldId }) || '';
          }

          // Common NetSuite patterns:
          // - "job" is the project/job entity on many transactions
          // - some implementations use "class" to represent project (as in your report column alias `...cls_srawfullname`)
          if (!projectName) projectName = tranRec.getText({ fieldId: 'job' }) || '';
          if (!projectName) projectName = tranRec.getText({ fieldId: 'class' }) || '';
        } catch (e) {
          // ignore; we'll proceed with empty projectName
        }
      }
      const artistKey = parseArtistKeyFromProjectName(projectName);
      const segValId = getSegmentValueInternalIdForArtistKey(artistKey);

      let headerUpdated = false;
      if (segValId) headerUpdated = trySetHeaderArtist(tranRec, headerArtistFieldId, segValId);

      let lineUpdatedCount = 0;
      let lineSkippedCount = 0;
      for (let i = 0; i < sublists.length; i += 1) {
        const res = trySetLineArtist(tranRec, sublists[i], lineArtistFieldId, lineProjectFieldId);
        lineUpdatedCount += res.updated;
        lineSkippedCount += res.skipped;
      }

      const anyChanges = headerUpdated || lineUpdatedCount > 0;
      if (!anyChanges) {
        log.audit({
          title: 'No changes',
          details: JSON.stringify({
            internalid: tranId,
            recordType,
            artistKey,
            segmentValueInternalId: segValId,
            lineUpdatedCount,
            lineSkippedCount,
          }),
        });
        return;
      }

      if (dryRun) {
        log.audit({
          title: 'Dry run - would update',
          details: JSON.stringify({
            internalid: tranId,
            recordType,
            artistKey,
            segmentValueInternalId: segValId,
            headerUpdated,
            lineUpdatedCount,
            lineSkippedCount,
          }),
        });
        return;
      }

      const savedId = tranRec.save({ enableSourcing: false, ignoreMandatoryFields: true });
      log.audit({
        title: 'Updated',
        details: JSON.stringify({
          internalid: savedId,
          recordType,
          artistKey,
          segmentValueInternalId: segValId,
          headerUpdated,
          lineUpdatedCount,
        }),
      });
    } catch (e) {
      log.error({ title: 'Reduce error', details: { internalid: tranId, recordType, error: e } });
    }
  }

  function summarize(summary) {
    const inputErrs = [];
    summary.inputSummary.errors.iterator().each((k, v) => {
      inputErrs.push({ key: k, error: v });
      return true;
    });

    const mapErrs = [];
    summary.mapSummary.errors.iterator().each((k, v) => {
      mapErrs.push({ key: k, error: v });
      return true;
    });

    const reduceErrs = [];
    summary.reduceSummary.errors.iterator().each((k, v) => {
      reduceErrs.push({ key: k, error: v });
      return true;
    });

    log.audit({
      title: 'Summary',
      details: JSON.stringify({
        seconds: summary.seconds,
        usage: summary.usage,
        yields: summary.yields,
        concurrency: summary.concurrency,
        inputErrors: inputErrs.slice(0, 50),
        mapErrors: mapErrs.slice(0, 50),
        reduceErrors: reduceErrs.slice(0, 50),
      }),
    });
  }

  return { getInputData, map, reduce, summarize };
});

