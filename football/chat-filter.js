// Extracted only the word data and display-filter behavior from the supplied
// Version Storage/bonkannotated.js: Bonk.charReplacements 38302–38342,
// Bonk.wab 38357–38449 (94 entries), profanityCheck 38454,
// sanitizeString 38480, censorString 38494. onChatMessage 2915 makes it optional.
// The public current client is obfuscated; this is the supplied list, not a
// claim that a separately maintained latest live list has been verified.
export const BONK_PROFANITY_TERMS = Object.freeze([
    'nigger', 'nigga', 'cunt', 'coon', 'fag', 'faggot', 'rape', 'negro', 'nig nog', 'nignog',
    'asshole', 'homo', 'bastard', 'slut', 'cock', 'fuck', 'bitch', 'pussy', 'whore', 'shit',
    'anus', 'bollocks', 'ballsack', 'ball sack', 'suck my', 'tits', 'clit', 'dick', 'fecal', 'feltch',
    'masturbate', 'wank', 'pedo', 'paedo', 'pedofile', 'pedophile', 'paedophile', 'paedofile', 'pegging', 'penis',
    'piss', 'poof', 'quim', 'rectum', 'scat', 'jizz', 'spunk', 'sperm', 'schlong', 'shlong',
    'shemale', 'smut', 'splooge', 'strapon', 'strap on', 'dildo', 'tosser', 'tushy', 'twat', 'vagina',
    'wank', 'white power', '씨발', 'ㅆㅂ', '개새', '십새', '섹스', '개자식', '미친새끼', '미친년',
    '뻑큐', '뻐큐', '쌍년', '쌍놈', '쌍넘', '쉑', '지랄', '창녀', '지럴', '좁밥',
    '좆', '좃까', '섹', '병신', '부랄', 'ㅄ', 'ㅂㅅ', 'ㅈㄹ', 'ㄳㄲ', 'ㄱㅅㄲ',
    '불알', '븅', '새꺄', '새갸'
]);
const replacements = new Map([['@', 'a'], ['0', 'o'], ['1', 'i'], ['2', 'r'], ['3', 'e'], ['4', 'a'], ['5', 's'], ['7', 't'], ['8', 'b'], ['9', 'g'], ['§', 's'], ['$', 's'], ['£', 'l'], ['€', 'e']]);
for (const [letters, replacement] of [['äãâáàå', 'a'], ['éèëê', 'e'], ['üûúù', 'u'], ['îïíì', 'i'], ['ÿý', 'y'], ['öôõóò', 'o']]) for (const letter of letters) replacements.set(letter, replacement);
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, {granularity:'grapheme'}) : null;
function normalized(text) {
    let folded = '', ranges = [], offset = 0;
    const segments = segmenter ? segmenter.segment(text) : Array.from(text, segment => {const result = {segment, index:offset}; offset += segment.length; return result;});
    for (const {segment, index} of segments) {
        const value = Array.from(segment.normalize('NFC').toLowerCase(), character => replacements.get(character) || character).join('');
        folded += value; for (let i = 0; i < value.length; i++) ranges.push([index, index + segment.length]);
    }
    return {folded, ranges};
}

// Match native list order and substring behavior, including inside longer
// words; replace with literal "bonk". Unicode ranges keep normalization/casing
// from cutting emoji or combining sequences. '$' is deliberately literal,
// correcting the old unescaped-RegExp end-anchor bug rather than repeating it.
export function maskProfanity(value) {
    if (typeof value !== 'string') return '';
    let text = value;
    for (;;) {
        const {folded, ranges} = normalized(text); let match = null;
        for (const word of BONK_PROFANITY_TERMS) {const at = folded.indexOf(word); if (at >= 0) {match = [ranges[at][0], ranges[at + word.length - 1][1]]; break;}}
        if (!match) return text;
        text = text.slice(0, match[0]) + 'bonk' + text.slice(match[1]);
    }
}
