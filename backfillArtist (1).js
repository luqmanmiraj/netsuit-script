/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * backfillArtistFromClass_Bills.js
 *
 * Purpose : One-time backfill — finds all transactions within a given date range
 *           that have a Class set but no Artist (cseg2), then fills Artist
 *           by matching any ":" separated part of the Class name against
 *           the Artist custom segment values (including partial/contains matching).
 *
 * Script Type : Map/Reduce
 * Entry Points: getInputData, map, summarize
 *
 * Parameters:
 *   custscript_backfill_start_date  — Start date (e.g. 01/01/2024)
 *   custscript_backfill_end_date    — End date   (e.g. 12/12/2025)
 *
 * Deploy:
 *   1. Customization → Scripting → Scripts → New → Upload this file
 *   2. Select "Map/Reduce Script"
 *   3. Set entry points:
 *        getInputData → getInputData
 *        Map          → map
 *        Summarize    → summarize
 *   4. Add Script Parameters:
 *        custscript_backfill_start_date  (Free-Form Text)
 *        custscript_backfill_end_date    (Free-Form Text)
 *   5. Save & Deploy → Status = Testing first
 *   6. Customization → Scripting → Script Deployments → Schedule → Save & Run
 */

define(['N/search', 'N/record', 'N/log', 'N/runtime'], (search, record, log, runtime) => {

    const ARTIST_FIELD = 'cseg2';

    // ── Load all Artist segment values into a lowercase map ──────────────────
    const loadArtistMap = () => {
        const map = {};
        search.create({
            type: 'customrecord_cseg2',
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'name' })
            ]
        }).run().each(result => {
            const id   = result.getValue({ name: 'internalid' });
            const name = result.getValue({ name: 'name' });
            if (name) map[name.trim().toLowerCase()] = { id, originalName: name.trim() };
            return true;
        });
        log.audit('loadArtistMap', `Loaded ${Object.keys(map).length} artists`);
        return map;
    };

    // ── Split class name by ":" and return first matching Artist ID ───────────
    // Matching strategy (in order of priority):
    //   1. Exact match  — part === artist name (case-insensitive)
    //   2. Contains match — part includes artist name OR artist name includes part
    // e.g. "OCTAVIO the Dweeb (Octavio Herrera):Cycle 1:Singles" → matches "OCTAVIO the Dweeb"
    const findArtistId = (className, artistMap) => {
        if (!className) return null;

        const parts = className.split(':');

        // Pass 1 — exact match
        for (const part of parts) {
            const partLower = part.trim().toLowerCase();
            if (artistMap.hasOwnProperty(partLower)) {
                const { id, originalName } = artistMap[partLower];
                log.debug('findArtistId - Exact Match', `Class part "${part.trim()}" exactly matched Artist "${originalName}" → ID ${id}`);
                log.debug('findArtistId - Exact Match',`[MATCH] ClassName part "${part.trim()}" EXACT matched Artist "${originalName}" (ID: ${id}) | Full className: "${className}"`);
                return id;
            }
        }

        // Pass 2 — contains match
        for (const part of parts) {
            const partLower = part.trim().toLowerCase();
            for (const [artistLower, { id, originalName }] of Object.entries(artistMap)) {
                if (partLower.includes(artistLower) || artistLower.includes(partLower)) {
                    log.debug('findArtistId - Contains Match', `Class part "${part.trim()}" contains-matched Artist "${originalName}" → ID ${id}`);
                    log.debug('findArtistId - Contains Match',`[MATCH] ClassName part "${part.trim()}" CONTAINS matched Artist "${originalName}" (ID: ${id}) | Full className: "${className}"`);
                    return id;
                }
            }
        }

        return null;
    };

    // ── getInputData: search ALL transaction types within date range, with Class but no Artist
    const getInputData = () => {
        const script    = runtime.getCurrentScript();
        const startDate = script.getParameter({ name: 'custscript_backfill_start_date' });
        const endDate   = script.getParameter({ name: 'custscript_backfill_end_date' });

        if (!startDate || !endDate) {
            throw new Error('Missing required parameters: custscript_backfill_start_date and custscript_backfill_end_date must both be set.');
        }

        log.audit('BackfillArtist', `Searching all transactions from ${startDate} to ${endDate}`);

        return search.create({
            type: search.Type.TRANSACTION,
            filters: [
                ['trandate',   'onorafter',  startDate],
                'AND',
                ['trandate',   'onorbefore', endDate],
                'AND',
                ['class',      'isnotempty', ''],
                'AND',
                [ARTIST_FIELD, 'anyof',      '@NONE@']
            ],
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'tranid' }),
                search.createColumn({ name: 'trandate' }),
                search.createColumn({ name: 'recordtype' }),
                search.createColumn({ name: 'class' }),
                search.createColumn({ name: 'entity' })
            ]
        });
    };

    // ── map: process one transaction at a time ────────────────────────────────
    const map = context => {
        const result  = JSON.parse(context.value);
        const txnId   = result.id;
        const values  = result.values;

        const tranid      = values.tranid;
        const trandate    = values.trandate;
        const recordtype  = values.recordtype;
        const classObj    = values['class'];
        const entity      = values.entity;

        let vendorName = '';
        if (entity) {
            if (Array.isArray(entity))          vendorName = entity[0] ? entity[0].text : '';
            else if (typeof entity === 'object') vendorName = entity.text || '';
            else                                 vendorName = String(entity);
        }

        let className = null;
        if (classObj) {
            if (Array.isArray(classObj))          className = classObj[0] ? classObj[0].text : null;
            else if (typeof classObj === 'object') className = classObj.text || null;
            else                                   className = String(classObj);
        }

        log.debug('map - raw class', JSON.stringify(classObj));
        log.debug('map', `Txn: ${tranid} | Type: ${recordtype} | Date: ${trandate} | Entity: ${vendorName} | Class: ${className}`);

        if (!className) {
            log.debug('map - Skip', `No class text on Txn ID ${txnId}`);
            return;
        }

        const artistMap = loadArtistMap();
        const artistId  = findArtistId(className, artistMap);

        if (!artistId) {
            log.debug('map - No Match', `No artist matched in class: "${className}" on Txn ${tranid}`);
            log.debug('map - No Match',`[NO MATCH] className: "${className}" | Txn: ${tranid} | Type: ${recordtype}`);
            return;
        }

        try {
            record.submitFields({
                type   : recordtype,
                id     : txnId,
                values : { [ARTIST_FIELD]: artistId },
                options: {
                    enableSourcing        : false,
                    ignoreMandatoryFields : true
                }
            });

            log.audit('map - Updated', `Txn ${tranid} (ID:${txnId}) | Type: ${recordtype} | Entity: ${vendorName} | Class: "${className}" → Artist ID: ${artistId}`);

            context.write({
                key  : txnId,
                value: JSON.stringify({
                    tranid    : tranid,
                    trandate  : trandate,
                    recordtype: recordtype,
                    entity    : vendorName,
                    className : className,
                    artistId  : artistId
                })
            });

        } catch (e) {
            log.error(`map - Error on Txn ${tranid} (ID:${txnId})`, e.message);
        }
    };

    // ── summarize: log final counts and any errors ────────────────────────────
    const summarize = summary => {
        let updated = 0;
        let errors  = 0;

        summary.output.iterator().each((key, value) => {
            updated++;
            const d = JSON.parse(value);
            log.audit('summarize', `${d.tranid} | ${d.recordtype} | ${d.trandate} | ${d.entity} | ${d.className} → Artist ${d.artistId}`);
            return true;
        });

        summary.mapSummary.errors.iterator().each((key, error) => {
            log.error('summarize - Error', `Key: ${key} | ${error}`);
            errors++;
            return true;
        });

        log.audit('BackfillArtist COMPLETE',
            `Updated: ${updated} transactions | Errors: ${errors}` +
            ` | Governance used: ${summary.usage}` +
            ` | Concurrency: ${summary.concurrency}`
        );
    };

    return {
        getInputData,
        map,
        summarize
    };
});
