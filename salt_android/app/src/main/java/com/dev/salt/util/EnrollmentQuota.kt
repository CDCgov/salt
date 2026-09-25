package com.dev.salt.util

import com.dev.salt.data.SurveyDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Optional per-facility enrollment quota (FacilityConfig.enrollmentQuota,
 * synced from the server). When set, the tablet stops starting new surveys —
 * for walk-ins and coupon holders alike — once the facility's enrolled count
 * reaches the quota. A null quota means no limit.
 *
 * Enrolled count = the server's facility-wide count from the last config sync
 * + this tablet's enrolled surveys the server count doesn't include yet (not
 * uploaded, or uploaded after that count was taken). This ignores local
 * history from other servers/facilities, covers multiple tablets, honors
 * server-side deletes, and stays exact for a single tablet while offline.
 *
 * If no server count has ever been received (older server), it falls back to
 * all enrolled surveys on the tablet. "Enrolled" = eligible completions, which
 * always set paymentConfirmed = true (ineligible ones never do).
 *
 * Surveys already in progress when the quota is reached are allowed to finish.
 */
object EnrollmentQuota {

    data class Status(val quota: Int?, val enrolled: Int) {
        val isLimited: Boolean get() = quota != null
        val isReached: Boolean get() = quota != null && enrolled >= quota
        val remaining: Int? get() = quota?.let { (it - enrolled).coerceAtLeast(0) }
    }

    /** Pure decision logic; a negative quota is treated as zero. */
    fun status(quota: Int?, enrolled: Int): Status =
        Status(quota?.coerceAtLeast(0), enrolled.coerceAtLeast(0))

    /**
     * Combines the counts. [serverCount] null = never received from the server,
     * in which case [localTotal] (all enrolled surveys on the tablet) is used.
     */
    fun enrolledCount(serverCount: Int?, localNotInServer: Int, localTotal: Int): Int =
        if (serverCount != null) serverCount + localNotInServer else localTotal

    /** Reads the quota and counts from the database. */
    suspend fun load(database: SurveyDatabase): Status = withContext(Dispatchers.IO) {
        val config = database.facilityConfigDao().getFacilityConfig()
        val serverCount = config?.serverEnrollmentCount
        val serverCountTime = config?.serverEnrollmentCountTime
        val dao = database.surveyDao()
        val enrolled = if (serverCount != null && serverCountTime != null) {
            enrolledCount(serverCount, dao.countEnrolledNotInServerCount(serverCountTime), 0)
        } else {
            enrolledCount(null, 0, dao.countEnrolledSurveys())
        }
        status(config?.enrollmentQuota, enrolled)
    }
}
