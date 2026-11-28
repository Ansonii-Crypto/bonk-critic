import assert from 'node:assert/strict';
import test from 'node:test';
import {scoringShotSpeed} from '../../football/modes.js';

test('Rockets ranks the latest slowing shot rather than the fastest attempt in the turn', () => {
    assert.equal(scoringShotSpeed([50, 40, 30, 10, 25, 24, 23]), 25);
    assert.equal(scoringShotSpeed([40, 30, 20, 35, 34, 33]), 35);
    assert.equal(scoringShotSpeed([60, 45, 30, 20, 10, 15, 14]), 15);
});

test('the whole final friction slope is followed back to its sampled peak', () => {
    const finalShot = Array.from({length: 45}, (_, tick) => 20 * 0.98 ** tick);
    assert.ok(finalShot.at(-1) < 9);
    assert.equal(scoringShotSpeed([55, 30, 5, ...finalShot]), 20);
});

test('equal-speed plateaus belong to the same final shot', () => {
    assert.equal(scoringShotSpeed([30, 10, 20, 20, 19, 19, 18]), 20);
    assert.equal(scoringShotSpeed([12, 12, 12]), 12);
    assert.equal(scoringShotSpeed([0, 0, 0]), 0);
});

test('a goal scored while speed is rising uses the last crossing sample', () => {
    assert.equal(scoringShotSpeed([10, 12, 15]), 15);
    assert.equal(scoringShotSpeed([50, 30, 5, 12, 15]), 15);
    assert.equal(scoringShotSpeed([5, 12, 15, 15]), 15);
});

test('a later acceleration ends the previous decay run even if that earlier peak was higher', () => {
    assert.equal(scoringShotSpeed([50, 40, 25, 26, 24]), 26);
    assert.equal(scoringShotSpeed([50, 40, 25, 26]), 26);
    assert.equal(scoringShotSpeed([50, 40, 0, 0, 26, 24]), 26);
});

test('speed-losing contacts remain in a decay run and speed-gaining contacts begin a new run', () => {
    assert.equal(scoringShotSpeed([25, 24.5, 12, 11.76]), 25);
    assert.equal(scoringShotSpeed([25, 24.5, 12, 18, 17.64]), 18);
});

test('small relative floating-point noise does not split an equal-speed plateau', () => {
    assert.equal(scoringShotSpeed([40, 30, 10, 20, 20 + 1e-8, 19]), 20 + 1e-8);
    assert.equal(scoringShotSpeed([1000, 1000 + 5e-7, 999]), 1000 + 5e-7);
    assert.equal(scoringShotSpeed([1e-12, 2e-12, 0]), 2e-12);
});

test('a real increase beyond floating-point tolerance splits the shot without display rounding', () => {
    assert.equal(scoringShotSpeed([40, 30, 20, 20.000001, 19]), 20.000001);
    assert.equal(scoringShotSpeed([30, 20, 12.34, 12.35, 12]), 12.35);
});

test('invalid older samples stop the search instead of joining disconnected history', () => {
    for (const invalid of [NaN, Infinity, -Infinity, -1, null, undefined, '20', {}, []]) {
        assert.equal(scoringShotSpeed([60, invalid, 20, 19]), 20);
    }
    const sparseHistory = [60, , 20, 19];
    assert.equal(scoringShotSpeed(sparseHistory), 20);
});

test('an invalid newest sample cannot produce a score from older valid attempts', () => {
    for (const invalid of [NaN, Infinity, -Infinity, -1, null, undefined, '20', {}, []]) {
        assert.equal(scoringShotSpeed([60, 20, invalid]), null);
    }
    assert.equal(scoringShotSpeed(new Array(3)), null);
});

test('empty or non-array metadata has no scoring speed', () => {
    for (const history of [[], null, undefined, 20, '20', {}, {0: 20, length: 1}, new Float64Array([20])]) {
        assert.equal(scoringShotSpeed(history), null);
    }
    assert.equal(scoringShotSpeed([0]), 0);
    assert.equal(scoringShotSpeed([24.5]), 24.5);
});

test('the helper neither mutates nor requires mutable history', () => {
    const history = Object.freeze([50, 25, 5, 20, 19.6, 19.208]);
    const original = [...history];
    assert.equal(scoringShotSpeed(history), 20);
    assert.deepEqual(history, original);
});

test('a full 900-tick turn still selects only its latest shot', () => {
    const history = Array.from({length: 901}, (_, tick) => tick < 850 ? 60 * 0.98 ** tick : 25 * 0.98 ** (tick - 850));
    assert.equal(history.length, 901);
    assert.ok(history[849] < history[850]);
    assert.equal(scoringShotSpeed(history), 25);
});
