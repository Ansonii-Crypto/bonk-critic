// Match settings shared by the browser and authoritative room server.
export const DEFAULT_MATCH_SETTINGS = Object.freeze({
    scoreLimit: 3,
    goalHeight: 13,
    kickImpulse: 15,
    moveForce: 32,
    ballRadius: 0.7,
    playerRadius: 1,
    pitchWidth: 730,
    pitchHeight: 500,
});

export const SETTING_RULES = Object.freeze({
    scoreLimit: Object.freeze({label: 'First to', min: 1, max: 9, step: 1, unit: 'goals'}),
    goalHeight: Object.freeze({label: 'Goal opening', min: 1, max: 40, step: 0.5, unit: 'm', disabledValue: -1}),
    kickImpulse: Object.freeze({label: 'Kick strength', min: 0, max: 60, step: 0.5, unit: 'N·s'}),
    moveForce: Object.freeze({label: 'Movement force', min: 0, max: 128, step: 1, unit: 'N'}),
    ballRadius: Object.freeze({label: 'Ball radius', min: 0.2, max: 3, step: 0.05, unit: 'm'}),
    playerRadius: Object.freeze({label: 'Player radius', min: 0.2, max: 3, step: 0.05, unit: 'm'}),
    pitchWidth: Object.freeze({label: 'Pitch width', min: 400, max: 1460, step: 10, unit: 'px'}),
    pitchHeight: Object.freeze({label: 'Pitch height', min: 300, max: 1000, step: 10, unit: 'px'}),
});

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateMatchSettings(patch, current = DEFAULT_MATCH_SETTINGS) {
    if (!isObject(patch)) return {settings: null, error: 'Match settings must be an object.'};
    if (!isObject(current)) return {settings: null, error: 'Current match settings must be an object.'};
    for (const key of Object.keys(patch)) {
        if (!Object.hasOwn(SETTING_RULES, key)) return {settings: null, error: `Unknown match setting: ${key}.`};
    }
    const settings = {...DEFAULT_MATCH_SETTINGS};
    // A room may hold other configuration, such as team capacity. Only match
    // settings are inherited; unrecognized keys are never accepted in a patch.
    for (const key of Object.keys(SETTING_RULES)) {
        if (Object.hasOwn(current, key)) settings[key] = current[key];
        if (Object.hasOwn(patch, key)) settings[key] = patch[key];
        const value = settings[key];
        const rule = SETTING_RULES[key];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return {settings: null, error: `${rule.label} must be a finite number.`};
        }
        if (key === 'scoreLimit' && !Number.isInteger(value)) {
            return {settings: null, error: 'First to must be a whole number from 1 to 9.'};
        }
        if (value !== rule.disabledValue && (value < rule.min || value > rule.max)) {
            const disabled = rule.disabledValue === undefined ? '' : `, or ${rule.disabledValue} to close the goals`;
            return {settings: null, error: `${rule.label} must be between ${rule.min} and ${rule.max}${disabled}.`};
        }
    }
    const ppm = 11;
    const innerWidth = (settings.pitchWidth - 60) / ppm;
    const innerHeight = (settings.pitchHeight - 150) / ppm;
    if (2 * Math.max(settings.ballRadius, settings.playerRadius) >= Math.min(innerWidth, innerHeight)) {
        return {settings: null, error: 'The ball and players must fit inside the pitch.'};
    }
    // Leave at least one display pixel of wall above and below each opening,
    // so side-wall polygons cannot collapse into zero-area fixtures.
    if (settings.goalHeight !== -1 && settings.goalHeight > innerHeight - 2 / ppm) {
        return {settings: null, error: 'The goal opening must fit inside the pitch height. Reduce the opening or increase the pitch height.'};
    }
    return {settings, error: null};
}
