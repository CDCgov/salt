package com.dev.salt.util

import org.junit.Assert.assertEquals
import org.junit.Test

class CouponCountResolverTest {

    @Test
    fun nullResultFallsBackToFacilityCount() {
        assertEquals(3, CouponCountResolver.resolve(null, 3))
    }

    @Test
    fun booleanTrueIssuesFacilityCount() {
        assertEquals(3, CouponCountResolver.resolve(true, 3))
    }

    @Test
    fun booleanFalseIssuesNone() {
        assertEquals(0, CouponCountResolver.resolve(false, 3))
    }

    @Test
    fun numberBelowCeilingIsUsed() {
        assertEquals(2, CouponCountResolver.resolve(2, 3))
        assertEquals(2, CouponCountResolver.resolve(2L, 3))
        assertEquals(2, CouponCountResolver.resolve(2.0, 3))
    }

    @Test
    fun numberAboveCeilingIsClampedToFacilityCount() {
        assertEquals(3, CouponCountResolver.resolve(10, 3))
        assertEquals(3, CouponCountResolver.resolve(Double.POSITIVE_INFINITY, 3))
    }

    @Test
    fun zeroIssuesNone() {
        assertEquals(0, CouponCountResolver.resolve(0, 3))
    }

    @Test
    fun negativeNumberIsClampedToZero() {
        assertEquals(0, CouponCountResolver.resolve(-4, 3))
    }

    @Test
    fun fractionalNumberIsFloored() {
        assertEquals(2, CouponCountResolver.resolve(2.9, 3))
        assertEquals(0, CouponCountResolver.resolve(0.99, 3))
    }

    @Test
    fun nanFallsBackToFacilityCount() {
        assertEquals(3, CouponCountResolver.resolve(Double.NaN, 3))
    }

    @Test
    fun numericAndBooleanStringsAreInterpreted() {
        assertEquals(1, CouponCountResolver.resolve("1", 3))
        assertEquals(3, CouponCountResolver.resolve(" true ", 3))
        assertEquals(0, CouponCountResolver.resolve("false", 3))
    }

    @Test
    fun unparseableStringFallsBackToFacilityCount() {
        assertEquals(3, CouponCountResolver.resolve("lots", 3))
    }

    @Test
    fun otherTypesFallBackToFacilityCount() {
        assertEquals(3, CouponCountResolver.resolve(listOf(1, 2), 3))
    }

    @Test
    fun negativeFacilityCountIsTreatedAsZero() {
        assertEquals(0, CouponCountResolver.resolve(5, -1))
        assertEquals(0, CouponCountResolver.resolve(null, -1))
    }
}
