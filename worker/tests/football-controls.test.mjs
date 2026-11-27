import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_KEYBINDS, canonicalBindingCode, legacyKeyCodeToCode, normalizeBonkControls, validateKeybinds} from '../../football/keybinds.js';
import {BONK_PROFANITY_TERMS, maskProfanity} from '../../football/chat-filter.js';

// Independent fixture writer follows CustomControls.serialize's documented
// big-endian wire order, including its version-specific non-gameplay fields.
function encoded(version = 6, patch = {}) {
    const data = {up1:38, up2:87, down1:40, down2:83, left1:37, left2:65, right1:39, right2:68, heavy1:88, heavy2:16, swing1:90, swing2:89, up3:999, down3:999, left3:999, right3:999, heavy3:32, swing3:999, filter:true, ...patch};
    const buffer = Buffer.alloc(({1:26, 2:27, 3:29, 4:30, 5:42, 6:43})[version]); let offset = 0;
    const ushort = value => {buffer.writeUInt16BE(value, offset); offset += 2;}, boolean = value => buffer.writeUInt8(Number(value), offset++);
    ushort(version); for (const key of ['up1', 'up2', 'down1', 'down2', 'left1', 'left2', 'right1', 'right2', 'heavy1', 'heavy2', 'swing1', 'swing2']) ushort(data[key]);
    if (version >= 2) boolean(data.filter); if (version >= 3) boolean(false); if (version >= 3 && version <= 5) boolean(true); if (version >= 4) boolean(true);
    if (version >= 5) for (const key of ['up3', 'down3', 'left3', 'right3', 'heavy3', 'swing3']) ushort(data[key]);
    if (version >= 6) ushort(3);
    assert.equal(offset, buffer.length); return buffer.toString('base64');
}

test('all six native account control versions decode their exact binary layout', () => {
    for (let version = 1; version <= 6; version++) {
        const result = normalizeBonkControls(encoded(version)); assert.deepEqual(result.bindings, DEFAULT_KEYBINDS);
        assert.equal(Object.hasOwn(result, 'filterProfanity'), version >= 2); if (version >= 2) assert.equal(result.filterProfanity, true);
        assert.deepEqual(Object.keys(result).sort(), version >= 2 ? ['bindings', 'filterProfanity'] : ['bindings']);
    }
});

test('custom third-slot keys, filter preference, generic modifiers, and explicit unbound values survive normalization', () => {
    const result = normalizeBonkControls(encoded(6, {left1:74, left2:999, left3:100, heavy2:17, heavy3:999, swing1:999, swing2:999, filter:false}));
    assert.deepEqual(result.bindings.left, ['KeyJ', 'Numpad4']); assert.deepEqual(result.bindings.action, ['KeyX', 'ControlLeft']); assert.deepEqual(result.bindings.action2, []); assert.equal(result.filterProfanity, false);
    assert.equal(canonicalBindingCode('ShiftRight'), 'ShiftLeft'); assert.equal(canonicalBindingCode('ControlRight'), 'ControlLeft'); assert.equal(canonicalBindingCode('AltRight'), 'AltLeft');
    assert.equal(legacyKeyCodeToCode(186), 'Semicolon'); assert.equal(legacyKeyCodeToCode(112), 'F1'); assert.equal(legacyKeyCodeToCode(999), null);
    const empty = Object.fromEntries(Object.keys(DEFAULT_KEYBINDS).map(action => [action, []])); assert.deepEqual(normalizeBonkControls({bindings:empty}).bindings, empty);
});

test('reserved keys are excluded from provider bindings and rejected clearly in local edits', () => {
    const result = normalizeBonkControls(encoded(6, {up1:13, up2:27})); assert.deepEqual(result.bindings.up, []);
    assert.match(validateKeybinds({...DEFAULT_KEYBINDS, up:['Enter']}).error, /reserved/);
    assert.match(validateKeybinds({...DEFAULT_KEYBINDS, up:['Escape']}).error, /reserved/);
    assert.equal(canonicalBindingCode('Enter'), null);
});

test('malformed, conflicting, oversized and unsupported provider controls fail closed without throwing', () => {
    const good = encoded(), bytes = Buffer.from(good, 'base64');
    const badVersion = Buffer.from(bytes); badVersion.writeUInt16BE(7);
    const badBoolean = Buffer.from(bytes); badBoolean[26] = 2;
    const badCode = Buffer.from(bytes); badCode.writeUInt16BE(65535, 2);
    for (const value of [null, undefined, [], '', 'not base64', 'a'.repeat(16388), good.slice(0, -4), Buffer.concat([bytes, Buffer.from([0])]).toString('base64'), badVersion.toString('base64'), badBoolean.toString('base64'), badCode.toString('base64'), {bindings:DEFAULT_KEYBINDS, token:'must-not-survive'}, {bindings:DEFAULT_KEYBINDS, filterProfanity:'false'}, {bindings:{...DEFAULT_KEYBINDS, left:['KeyX']}}, {bindings:DEFAULT_KEYBINDS, padding:'x'.repeat(16384)}]) assert.equal(normalizeBonkControls(value), null);
    assert.match(validateKeybinds({...DEFAULT_KEYBINDS, left:['KeyX']}).error, /more than once/);
    assert.match(validateKeybinds({...DEFAULT_KEYBINDS, left:['KeyA', 'ArrowLeft', 'KeyJ', 'KeyH']}).error, /three/);
    assert.equal(validateKeybinds({...DEFAULT_KEYBINDS, left:[{toString() {throw Error('Do not coerce objects.');}}]}).bindings, null);
});

test('the complete supplied Bonk profanity list is included with native substring/list-priority behavior', () => {
    assert.equal(BONK_PROFANITY_TERMS.length, 94); assert.equal(BONK_PROFANITY_TERMS.filter(word => word === 'wank').length, 2);
    for (const word of BONK_PROFANITY_TERMS) assert.notEqual(maskProfanity(word), word, word);
    assert.equal(maskProfanity('FUCK SHIT'), 'bonk bonk'); assert.equal(maskProfanity('faggot'), 'bonkgot');
    assert.equal(maskProfanity('grape Scunthorpe'), 'gbonk Sbonkhorpe'); assert.equal(maskProfanity('football gg nice goal!'), 'football gg nice goal!');
});

test('filter normalization masks accents/leet/Korean while preserving Unicode grapheme boundaries and untouched text', () => {
    assert.equal(maskProfanity('🧑‍🤝‍🧑 fÜck 씨발 café'), '🧑‍🤝‍🧑 bonk bonk café');
    assert.equal(maskProfanity('prefix e\u0301 fu\u0308ck suffix'), 'prefix e\u0301 bonk suffix');
    assert.equal(maskProfanity('b1tch and a$$hole'), 'bonk and bonk');
    assert.equal(maskProfanity('씨발'.normalize('NFD')), 'bonk'); assert.equal(maskProfanity('🇬🇧 sh1t!'), '🇬🇧 bonk!');
    assert.equal(maskProfanity(null), '');
});
