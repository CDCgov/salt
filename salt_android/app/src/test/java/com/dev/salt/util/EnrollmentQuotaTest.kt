package com.dev.salt.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EnrollmentQuotaTest {

    @Test
    fun noQuotaIsNeverReached() {
        val s = EnrollmentQuota.status(null, 10_000)
        assertFalse(s.isLimited)
        assertFalse(s.isReached)
        assertNull(s.remaining)
    }

    @Test
    fun belowQuotaIsNotReached() {
        val s = EnrollmentQuota.status(50, 49)
        assertTrue(s.isLimited)
        assertFalse(s.isReached)
        assertEquals(1, s.remaining)
    }

    @Test
    fun atQuotaIsReached() {
        val s = EnrollmentQuota.status(50, 50)
        assertTrue(s.isReached)
        assertEquals(0, s.remaining)
    }

    @Test
    fun overQuotaIsReachedWithZeroRemaining() {
        val s = EnrollmentQuota.status(50, 53)
        assertTrue(s.isReached)
        assertEquals(0, s.remaining)
    }

    @Test
    fun zeroQuotaBlocksImmediately() {
        assertTrue(EnrollmentQuota.status(0, 0).isReached)
    }

    @Test
    fun negativeQuotaIsTreatedAsZero() {
        val s = EnrollmentQuota.status(-5, 0)
        assertEquals(0, s.quota)
        assertTrue(s.isReached)
    }
}

class EnrollmentCountTest {

    @Test
    fun serverCountPlusLocalNotYetCounted() {
        // 30 on the server, 2 finished here since the last sync
        assertEquals(32, EnrollmentQuota.enrolledCount(30, 2, 109))
    }

    @Test
    fun localHistoryIsIgnoredWhenServerCountKnown() {
        // 109 old local surveys (other servers/facilities) must not count
        assertEquals(30, EnrollmentQuota.enrolledCount(30, 0, 109))
    }

    @Test
    fun fallsBackToLocalTotalWithoutServerCount() {
        assertEquals(109, EnrollmentQuota.enrolledCount(null, 5, 109))
    }
}
