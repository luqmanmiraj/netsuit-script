/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * clearArtist.js
 *
 * Purpose : Reverse backfill — finds all transactions within a given date range
 *           that currently have an Artist (cseg2) value and clears it out.
 *
 * Script Type : Map/Reduce
 * Entry Points: getInputData, map, summarize
 *
 * Parameters:
 *   custscript_clear_start_date  — Start date (e.g. 01/01/2024)
 *   custscript_clear_end_date    — End date   (e.g. 12/12/2025)
 *
 * Deploy:
 *   1. Customization → Scripting → Scripts → New → Upload this file
 *   2. Select "Map/Reduce Script"
 *   3. Set entry points:
 *        getInputData → getInputData
 *        Map          → map
 *        Summarize    → summarize
 *   4. Add Script Parameters:
 *        custscript_clear_start_date  (Free-Form Text)
 *        custscript_clear_end_date    (Free-Form Text)
 *   5. Save & Deploy → Status = Testing first
 *   6. Customization → Scripting → Script Deployments → Schedule → Save & Run
 */

define(['N/search', 'N/record', 'N/log', 'N/runtime'], (search, record, log, runtime) => {

    const ARTIST_FIELD = 'cseg2';

    // ── getInputData: transactions in date range that currently have Artist set ─
    const getInputData = () => {
        const script    = runtime.getCurrentScript();
        const startDate = script.getParameter({ name: 'custscript_v2_clear_artist_start_date' });
        const endDate   = script.getParameter({ name: 'custscript_v2_clear_artist_end_date' });

        if (!startDate || !endDate) {
            throw new Error('Missing required parameters: custscript_clear_start_date and custscript_clear_end_date must both be set.');
        }

        log.audit('ClearArtist', `Searching all transactions from ${startDate} to ${endDate} with Artist set`);

        return search.create({
            type: search.Type.TRANSACTION,
            filters: [
                ['trandate',   'onorafter',  startDate],
                'AND',
                ['trandate',   'onorbefore', endDate],
                'AND',
                ['class',      'isnotempty', ''],
                'AND',
                [ARTIST_FIELD, 'noneof',     '@NONE@']
            ],
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'tranid' }),
                search.createColumn({ name: 'trandate' }),
                search.createColumn({ name: 'recordtype' }),
                search.createColumn({ name: 'class' }),
                search.createColumn({ name: 'entity' }),
                search.createColumn({ name: ARTIST_FIELD })
            ]
        });
    };

    // ── map: clear Artist value on each transaction ────────────────────────────
    const map = context => {
        const result = JSON.parse(context.value);
        const txnId  = result.id;
        const values = result.values;

        const tranid     = values.tranid;
        const trandate   = values.trandate;
        const recordtype = values.recordtype;
        const classObj   = values['class'];
        const entity     = values.entity;
        const artistObj  = values[ARTIST_FIELD];

        let vendorName = '';
        if (entity) {
            if (Array.isArray(entity))            vendorName = entity[0] ? entity[0].text : '';
            else if (typeof entity === 'object') vendorName = entity.text || '';
            else                                  vendorName = String(entity);
        }

        let className = '';
        if (classObj) {
            if (Array.isArray(classObj))            className = classObj[0] ? classObj[0].text : '';
            else if (typeof classObj === 'object') className = classObj.text || '';
            else                                    className = String(classObj);
        }

        let currentArtist = '';
        if (artistObj) {
            if (Array.isArray(artistObj))            currentArtist = artistObj[0] ? artistObj[0].text || artistObj[0].value || '' : '';
            else if (typeof artistObj === 'object') currentArtist = artistObj.text || artistObj.value || '';
            else                                     currentArtist = String(artistObj);
        }

        try {
            record.submitFields({
                type   : recordtype,
                id     : txnId,
                values : { [ARTIST_FIELD]: '' },
                options: {
                    enableSourcing        : false,
                    ignoreMandatoryFields : true
                }
            });

            log.audit('map - Cleared', `Txn ${tranid} (ID:${txnId}) | Type: ${recordtype} | Date: ${trandate} | Entity: ${vendorName} | Class: "${className}" | Artist Cleared: "${currentArtist}"`);

            context.write({
                key  : txnId,
                value: JSON.stringify({
                    tranid      : tranid,
                    trandate    : trandate,
                    recordtype  : recordtype,
                    entity      : vendorName,
                    className   : className,
                    clearedFrom : currentArtist
                })
            });
        } catch (e) {
            log.error(`map - Error on Txn ${tranid} (ID:${txnId})`, e.message);
        }
    };

    // ── summarize: log final counts and any errors ─────────────────────────────
    const summarize = summary => {
        let cleared = 0;
        let errors  = 0;

        summary.output.iterator().each((key, value) => {
            cleared++;
            const d = JSON.parse(value);
            log.audit('summarize', `${d.tranid} | ${d.recordtype} | ${d.trandate} | ${d.entity} | ${d.className} → Cleared Artist "${d.clearedFrom}"`);
            return true;
        });

        summary.mapSummary.errors.iterator().each((key, error) => {
            log.error('summarize - Error', `Key: ${key} | ${error}`);
            errors++;
            return true;
        });

        log.audit('ClearArtist COMPLETE',
            `Cleared: ${cleared} transactions | Errors: ${errors}` +
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
