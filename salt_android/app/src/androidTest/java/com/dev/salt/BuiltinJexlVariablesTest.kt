package com.dev.salt

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.dev.salt.data.FacilityConfig
import com.dev.salt.data.Survey
import com.dev.salt.data.SurveyDatabase
import com.dev.salt.util.LabTestJexlEvaluator
import com.dev.salt.viewmodel.SurveyViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The built-in JEXL variables _facility_name, _facility_id and _is_seed:
 * their values, how the tablet's JEXL engine evaluates them, and that both
 * survey scripts (SurveyViewModel) and lab test conditions get them. The server's checker accepts the same names
 * (salt_management/src/services/builtinVariables.js).
 *
 * Temporarily replaces this device's facility config and adds two surveys;
 * both are restored or removed afterwards.
 */
@RunWith(AndroidJUnit4::class)
class BuiltinJexlVariablesTest {
    private val clinic = FacilityConfig(facilityId = 3, facilityName = "Clinic A")

    @Test
    fun values() {
        val seed = builtinJexlVariables(clinic, null)
        assertEquals("Clinic A", seed["_facility_name"])
        assertEquals(3, seed["_facility_id"])
        assertEquals(true, seed["_is_seed"])
        assertEquals(true, builtinJexlVariables(clinic, " ")["_is_seed"])
        assertEquals(false, builtinJexlVariables(clinic, "ABC123")["_is_seed"])

        // Before tablet setup there is no facility.
        val unset = builtinJexlVariables(null, "ABC123")
        assertNull(unset["_facility_name"])
        assertNull(unset["_facility_id"])
    }

    @Test
    fun evaluatesOnTheTabletEngine() {
        val ctx = builtinJexlVariables(clinic, null) + mapOf("age" to 17)
        val cases = mapOf(
            "_is_seed" to true,
            "!_is_seed" to false,
            "_is_seed == 1" to true,
            "_is_seed && age < 18" to true,
            "_facility_id == 3" to true,
            "_facility_name == 'Clinic A'" to true,
            "_facility_name =~ ['Clinic B', 'Clinic A']" to true,
            "_facility_name == 'Clinic B'" to false
        )
        for ((script, expected) in cases) {
            assertEquals(script, expected, evaluateJexlScript(script, ctx, throwErrors = true))
        }
        // No facility yet: comparisons are false rather than errors.
        assertEquals(false, evaluateJexlScript("_facility_id == 3", builtinJexlVariables(null, null), throwErrors = true))
    }

    @Test
    fun surveyScriptsGetThem() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val db = SurveyDatabase.getInstance(context)
        val saved = db.facilityConfigDao().getFacilityConfig()
        val started = mutableListOf<Survey>()
        try {
            db.facilityConfigDao().insertOrUpdate((saved ?: FacilityConfig()).copy(facilityId = 3, facilityName = "Clinic A"))
            for ((coupon, isSeed) in listOf(null to true, "ABC123" to false)) {
                var vm: SurveyViewModel? = null
                instrumentation.runOnMainSync { vm = SurveyViewModel(db, context, referralCouponCode = coupon) }
                val deadline = System.currentTimeMillis() + 10_000
                while (vm!!.survey == null && System.currentTimeMillis() < deadline) Thread.sleep(50)
                assertNotNull("survey did not start", vm!!.survey)
                started += vm!!.survey!!
                val ctx = vm!!.buildJexlContext()
                assertEquals(isSeed, ctx["_is_seed"])
                assertEquals("Clinic A", ctx["_facility_name"])
                assertEquals(3, ctx["_facility_id"])
            }
        } finally {
            started.forEach { db.surveyDao().deleteSurvey(it) }
            if (saved != null) db.facilityConfigDao().insertOrUpdate(saved) else db.facilityConfigDao().deleteAll()
        }
    }

    @Test
    fun labTestConditionsGetThem() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = SurveyDatabase.getInstance(context)
        val saved = db.facilityConfigDao().getFacilityConfig()
        val seed = Survey(subjectId = "W-test-seed", startDatetime = 0, language = "English")
        val recruit = Survey(subjectId = "R-test", startDatetime = 0, language = "English", referralCouponCode = "ABC123")
        try {
            db.facilityConfigDao().insertOrUpdate((saved ?: FacilityConfig()).copy(facilityId = 3, facilityName = "Clinic A"))
            db.surveyDao().insertSurvey(seed)
            db.surveyDao().insertSurvey(recruit)

            val seedCtx = LabTestJexlEvaluator.buildContext(seed.id, db).combinedContext
            assertEquals(true, seedCtx["_is_seed"])
            assertEquals("Clinic A", seedCtx["_facility_name"])
            assertEquals(3, seedCtx["_facility_id"])
            assertEquals(Pair(true, true), LabTestJexlEvaluator.evaluateCondition("_is_seed && _facility_id == 3", seedCtx))

            val recruitCtx = LabTestJexlEvaluator.buildContext(recruit.id, db).combinedContext
            assertEquals(false, recruitCtx["_is_seed"])
            assertEquals(false, LabTestJexlEvaluator.evaluateCondition("_is_seed", recruitCtx).first)
        } finally {
            db.surveyDao().deleteSurvey(seed)
            db.surveyDao().deleteSurvey(recruit)
            if (saved != null) db.facilityConfigDao().insertOrUpdate(saved) else db.facilityConfigDao().deleteAll()
        }
    }
}
