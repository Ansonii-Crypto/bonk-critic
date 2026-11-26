// Shared by the browser and Worker. Ability thresholds never depend on player counts.
(function (root) {
    'use strict';

    const attributes = 6;
    const cutoffs = Object.freeze([
        ['E', 43], ['D', 86], ['C', 129], ['B', 193], ['A', 216], ['S', 256]
    ].map(([tier, score]) => Object.freeze({ tier, score, total: score * attributes })));

    function tierForTotal(value) {
        const total = Number(value);
        if (!Number.isFinite(total)) return 'F';
        for (let index = cutoffs.length - 1; index >= 0; index--) {
            if (total >= cutoffs[index].total) return cutoffs[index].tier;
        }
        return 'F';
    }

    function tierForScore(value) {
        return tierForTotal(Number(value) * attributes);
    }

    root.BonkRatings = Object.freeze({
        cutoffs,
        tierForTotal,
        tierForScore,
        metadata: Object.freeze({
            version: '2026-11-26-fixed-score-v1',
            effectiveAt: '2026-11-26',
            method: 'Fixed ability thresholds based only on the six attribute scores.',
            attributes,
            maxScore: 300
        })
    });
})(globalThis);
