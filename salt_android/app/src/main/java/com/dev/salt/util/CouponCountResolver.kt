package com.dev.salt.util

import kotlin.math.floor

/**
 * Turns the result of a survey's optional `coupon_count_script` (JEXL) into the
 * number of coupons to issue at survey completion.
 *
 * The facility's `coupons_to_issue` is always the ceiling; the script can only
 * lower it. Semantics of the script result:
 *
 * | result                          | coupons issued                          |
 * |---------------------------------|-----------------------------------------|
 * | null (blank script / error)     | facility count                          |
 * | number `n`                      | `max(0, min(floor(n), facility count))` |
 * | `true` / `false`                | facility count / 0                      |
 * | numeric or boolean string       | as above                                |
 * | anything else                   | facility count                          |
 *
 * Falling back to the facility count on error is deliberate: a broken script
 * must not silently stop recruitment.
 */
object CouponCountResolver {

    fun resolve(scriptResult: Any?, facilityCount: Int): Int {
        val ceiling = facilityCount.coerceAtLeast(0)
        return when (scriptResult) {
            null -> ceiling
            is Boolean -> if (scriptResult) ceiling else 0
            is Number -> clampNumber(scriptResult.toDouble(), ceiling)
            is String -> resolveString(scriptResult, ceiling)
            else -> ceiling
        }
    }

    private fun resolveString(s: String, ceiling: Int): Int {
        val t = s.trim()
        return when {
            t.equals("true", ignoreCase = true) -> ceiling
            t.equals("false", ignoreCase = true) -> 0
            else -> t.toDoubleOrNull()?.let { clampNumber(it, ceiling) } ?: ceiling
        }
    }

    private fun clampNumber(d: Double, ceiling: Int): Int {
        if (d.isNaN()) return ceiling
        return floor(d).coerceIn(0.0, ceiling.toDouble()).toInt()
    }
}
