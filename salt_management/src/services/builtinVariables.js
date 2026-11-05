/**
 * Built-in JEXL variables and the short names they reserve.
 *
 * The tablet adds these to every survey script and lab test condition
 * (salt_android Util.kt builtinJexlVariables):
 *   _facility_name  the tablet's facility name (text)
 *   _facility_id    the tablet's facility id on this server (number)
 *   _is_seed        true when the participant came without a referral coupon
 *
 * Every name starting with "_" is reserved for built-ins, so no question
 * short name may start with "_". `value` (the current answer in validation
 * and skip-to scripts) and `facility_coupons` (the coupon ceiling in the
 * coupon count script) are reserved too.
 */

const BUILTIN_VARIABLES = {
    _facility_name: 'text',
    _facility_id: 'number',
    _is_seed: 'boolean'
};

const RESERVED_NAMES = {
    value: '"value" is a reserved name and cannot be used as a short name',
    facility_coupons: '"facility_coupons" is a reserved name and cannot be used as a short name'
};

/** Error message when a short name is reserved, or null when it may be used. */
function reservedShortNameError(shortName) {
    if (typeof shortName !== 'string') return null;
    if (RESERVED_NAMES[shortName]) return RESERVED_NAMES[shortName];
    if (shortName.startsWith('_')) {
        return `Short names cannot start with "_" ("${shortName}"); those names are built-in variables such as _is_seed`;
    }
    return null;
}

module.exports = { BUILTIN_VARIABLES, reservedShortNameError };
