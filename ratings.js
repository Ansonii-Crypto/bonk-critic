// Shared by the browser and Worker. Cutoffs are fixed until a reviewed recalibration.
(function (root) {
    'use strict';

    const cutoffs = Object.freeze([
        Object.freeze({ tier: 'E', total: 1030, percentile: 5 }),
        Object.freeze({ tier: 'D', total: 1199, percentile: 20 }),
        Object.freeze({ tier: 'C', total: 1279, percentile: 40 }),
        Object.freeze({ tier: 'B', total: 1427, percentile: 60 }),
        Object.freeze({ tier: 'A', total: 1509, percentile: 80 }),
        Object.freeze({ tier: 'S', total: 1591, percentile: 95 })
    ]);

    function tierForTotal(value) {
        const total = Number(value);
        if (!Number.isFinite(total)) return 'F';
        for (let index = cutoffs.length - 1; index >= 0; index--) {
            if (total >= cutoffs[index].total) return cutoffs[index].tier;
        }
        return 'F';
    }

    function tierForScore(value) {
        return tierForTotal(Number(value) * 6);
    }

    root.BonkRatings = Object.freeze({
        cutoffs,
        tierForTotal,
        tierForScore,
        metadata: Object.freeze({
            version: '2026-11-25-percentiles-v1',
            calibratedAt: '2026-11-25',
            sampleSize: 20,
            method: 'Linear-interpolated percentiles of current published player totals, rounded up.',
            referenceTotals: Object.freeze([1002, 1031, 1180, 1183, 1203, 1244, 1264, 1264, 1288, 1302, 1369, 1405, 1460, 1483, 1488, 1492, 1577, 1579, 1589, 1629])
        })
    });
})(globalThis);
