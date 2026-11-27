// Bonk provenance: supplied Version Storage/bonkannotated.js, CustomControls
// (7335–7474), ByteStream.readUShort (6695), keyboard keyCode handling (15539).
// Login loads response.controls at 17420; account_savecontrols.php saves its
// base64 representation at 18898–18903. No provider token belongs in this data.
export const BINDING_ACTIONS = Object.freeze(['left', 'right', 'up', 'down', 'action', 'action2']);
export const DEFAULT_KEYBINDS = Object.freeze({
    left:Object.freeze(['ArrowLeft', 'KeyA']), right:Object.freeze(['ArrowRight', 'KeyD']),
    up:Object.freeze(['ArrowUp', 'KeyW']), down:Object.freeze(['ArrowDown', 'KeyS']),
    action:Object.freeze(['KeyX', 'ShiftLeft', 'Space']), action2:Object.freeze(['KeyZ', 'KeyY'])
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const MAX_SOURCE_LENGTH = 16384;
const genericModifiers = Object.freeze({ShiftRight:'ShiftLeft', ControlRight:'ControlLeft', AltRight:'AltLeft'});
const namedCodes = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'ShiftLeft', 'ControlLeft', 'AltLeft', 'MetaLeft', 'MetaRight', 'Backspace', 'Tab', 'Pause', 'CapsLock', 'PageUp', 'PageDown', 'End', 'Home', 'PrintScreen', 'Insert', 'Delete', 'ContextMenu', 'NumLock', 'ScrollLock', 'Semicolon', 'Equal', 'Comma', 'Minus', 'Period', 'Slash', 'Backquote', 'BracketLeft', 'Backslash', 'BracketRight', 'Quote', 'IntlBackslash', 'NumpadMultiply', 'NumpadAdd', 'NumpadComma', 'NumpadSubtract', 'NumpadDecimal', 'NumpadDivide']);
function allowedCode(code) {return typeof code === 'string' && (namedCodes.has(code) || /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || /^Numpad[0-9]$/.test(code) || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code));}

// Legacy keyCode cannot distinguish modifier sides. Keep physical keys in the
// held-key set, then canonicalize each code for lookup so releasing one Shift
// cannot release the other Shift while it remains held.
export function canonicalBindingCode(code) {
    if (typeof code !== 'string') return null;
    const canonical = genericModifiers[code] || code;
    return allowedCode(canonical) ? canonical : null;
}
const legacyCodes = new Map(Object.entries({8:'Backspace', 9:'Tab', 12:'Numpad5', 16:'ShiftLeft', 17:'ControlLeft', 18:'AltLeft', 19:'Pause', 20:'CapsLock', 32:'Space', 33:'PageUp', 34:'PageDown', 35:'End', 36:'Home', 37:'ArrowLeft', 38:'ArrowUp', 39:'ArrowRight', 40:'ArrowDown', 44:'PrintScreen', 45:'Insert', 46:'Delete', 59:'Semicolon', 61:'Equal', 91:'MetaLeft', 92:'MetaRight', 93:'ContextMenu', 106:'NumpadMultiply', 107:'NumpadAdd', 108:'NumpadComma', 109:'NumpadSubtract', 110:'NumpadDecimal', 111:'NumpadDivide', 144:'NumLock', 145:'ScrollLock', 173:'Minus', 186:'Semicolon', 187:'Equal', 188:'Comma', 189:'Minus', 190:'Period', 191:'Slash', 192:'Backquote', 219:'BracketLeft', 220:'Backslash', 221:'BracketRight', 222:'Quote', 226:'IntlBackslash'}).map(([key, value]) => [Number(key), value]));
export function legacyKeyCodeToCode(value) {
    if (!Number.isInteger(value)) return null;
    if (value >= 48 && value <= 57) return 'Digit' + (value - 48);
    if (value >= 65 && value <= 90) return 'Key' + String.fromCharCode(value);
    if (value >= 96 && value <= 105) return 'Numpad' + (value - 96);
    if (value >= 112 && value <= 135) return 'F' + (value - 111);
    return legacyCodes.get(value) || null;
}
export function validateKeybinds(value) {
    const fail = error => ({bindings:null, error});
    if (!object(value) || Object.keys(value).length !== BINDING_ACTIONS.length || Object.keys(value).some(key => !BINDING_ACTIONS.includes(key))) return fail('Provide bindings for all six actions.');
    const bindings = {}, used = new Set();
    for (const action of BINDING_ACTIONS) {
        if (!own(value, action) || !Array.isArray(value[action]) || value[action].length > 3) return fail('Each action accepts up to three keys.');
        bindings[action] = [];
        for (const raw of value[action]) {
            if (raw === 'Enter' || raw === 'NumpadEnter' || raw === 'Escape') return fail('Enter and Escape are reserved for chat and menus.');
            const code = canonicalBindingCode(raw);
            if (!code) return fail('Choose a supported keyboard key.');
            if (used.has(code)) return fail(code + ' is assigned more than once.');
            used.add(code); bindings[action].push(code);
        }
    }
    return {bindings, error:null};
}
const nativeAction = Object.freeze({left:'left', right:'right', up:'up', down:'down', action:'heavy', action2:'swing'});
function decodeNative(encoded) {
    if (!encoded.length || encoded.length > MAX_SOURCE_LENGTH || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return null;
    let binary; try {binary = atob(encoded);} catch {return null;}
    const lengths = {1:26, 2:27, 3:29, 4:30, 5:42, 6:43};
    if (binary.length < 2) return null;
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0)), view = new DataView(bytes.buffer); let at = 0;
    const ushort = () => {const value = view.getUint16(at); at += 2; return value;};
    const bool = () => {const value = view.getUint8(at++); if (value !== 0 && value !== 1) throw Error('Invalid native boolean.'); return value === 1;};
    try {
        const version = ushort(); if (binary.length !== lengths[version]) return null;
        const controls = {};
        for (const action of ['up', 'down', 'left', 'right', 'heavy', 'swing']) {controls[action + '1'] = ushort(); controls[action + '2'] = ushort(); controls[action + '3'] = action === 'heavy' && version < 5 ? 32 : 999;}
        if (version >= 2) controls.filter = bool();
        if (version >= 3) bool();
        if (version >= 3 && version <= 5) bool();
        if (version >= 4) bool();
        if (version >= 5) for (const action of ['up', 'down', 'left', 'right', 'heavy', 'swing']) controls[action + '3'] = ushort();
        if (version >= 6) ushort();
        return controls;
    } catch {return null;}
}
function preference(value) {return value === true || value === 1 ? true : value === false || value === 0 ? false : null;}

// Accept the real account payload and bounded explicit import formats. Only
// six gameplay actions plus the optional filter preference leave this module.
export function normalizeBonkControls(source) {
    try {
        if (typeof source === 'string') source = decodeNative(source);
        else if (object(source) && JSON.stringify(source).length > MAX_SOURCE_LENGTH) return null;
        if (!object(source)) return null;
        let checked, filter;
        if (own(source, 'bindings')) {
            if (Object.keys(source).some(key => !['bindings', 'filterProfanity'].includes(key))) return null;
            checked = validateKeybinds(source.bindings); if (own(source, 'filterProfanity')) filter = preference(source.filterProfanity);
            if (own(source, 'filterProfanity') && filter === null) return null;
        } else if (BINDING_ACTIONS.some(action => own(source, action))) {
            if (Object.keys(source).some(key => !BINDING_ACTIONS.includes(key) && key !== 'filterProfanity')) return null;
            const bindings = Object.fromEntries(BINDING_ACTIONS.map(action => [action, source[action]])); checked = validateKeybinds(bindings);
            if (own(source, 'filterProfanity')) {filter = preference(source.filterProfanity); if (filter === null) return null;}
        } else {
            const permitted = new Set(['filter']); for (const action of Object.values(nativeAction)) for (let slot = 1; slot <= 3; slot++) permitted.add(action + slot);
            if (Object.keys(source).length > 19 || Object.keys(source).some(key => !permitted.has(key))) return null;
            const bindings = {};
            for (const action of BINDING_ACTIONS) {
                bindings[action] = []; const native = nativeAction[action];
                for (let slot = 1; slot <= 3; slot++) {
                    const key = native + slot;
                    if (!own(source, key)) {if (slot < 3) return null; continue;}
                    const value = source[key]; if (!Number.isInteger(value) || value < 0 || value > 65535) return null;
                    if (value === 999 || value === 0 || value === 13 || value === 27) continue;
                    const code = legacyKeyCodeToCode(value); if (!code) return null; bindings[action].push(code);
                }
            }
            checked = validateKeybinds(bindings); if (own(source, 'filter')) {filter = preference(source.filter); if (filter === null) return null;}
        }
        if (checked.error) return null;
        return {...(filter === undefined ? {} : {filterProfanity:filter}), bindings:checked.bindings};
    } catch {return null;}
}
