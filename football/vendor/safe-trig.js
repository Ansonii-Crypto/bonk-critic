// Deterministic rounding used by the supplied Bonk physics library.
// Matches https://bonk.io/js/SafeTrig.js: seven decimal places after trig.
const rounded = value => Math.round(value * 10000000) / 10000000;

export default Object.freeze({
    safeSin: value => rounded(Math.sin(value)),
    safeCos: value => rounded(Math.cos(value)),
    safeTan: value => rounded(Math.tan(value)),
    safeASin: value => rounded(Math.asin(value)),
    safeACos: value => rounded(Math.acos(value)),
    safeATan: value => rounded(Math.atan(value)),
    safeATan2: (y, x) => rounded(Math.atan2(y, x))
});
