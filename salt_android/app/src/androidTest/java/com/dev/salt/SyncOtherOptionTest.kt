package com.dev.salt

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.dev.salt.data.SurveyDatabase
import com.dev.salt.sync.SurveySyncManager
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The tablet reads options.is_other from a real survey download.
 * Fixture: assets/sync_other_fixture.json, the `data` object of
 * GET /api/sync/survey/download for a survey whose `gender` and `drugs`
 * questions have an "other" option at position 2 (audio stripped).
 *
 * Runs the private SurveySyncManager.insertSurveyData through reflection,
 * so it replaces the survey stored in this device's app database.
 */
@RunWith(AndroidJUnit4::class)
class SyncOtherOptionTest {
    @Test
    fun isOtherSurvivesSync() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val fixture = instrumentation.context.assets.open("sync_other_fixture.json")
            .bufferedReader().use { it.readText() }

        val manager = SurveySyncManager(context)
        SurveySyncManager::class.java.getDeclaredMethod("clearExistingData")
            .apply { isAccessible = true }.invoke(manager)
        SurveySyncManager::class.java.getDeclaredMethod("insertSurveyData", JSONObject::class.java)
            .apply { isAccessible = true }.invoke(manager, JSONObject(fixture))

        val dao = SurveyDatabase.getInstance(context).surveyDao()
        val questions = dao.getAllQuestions().associateBy { it.id }
        val others = dao.getOtherOptions()
        val otherByQuestion = others.associate { questions[it.questionId]!!.questionShortName to it.optionQuestionIndex }
        assertEquals(mapOf("gender" to 2, "drugs" to 2), otherByQuestion)

        // Every other option is a normal one.
        val plain = questions.values.first { it.questionShortName == "plain" }
        val plainOptions = dao.getOptionsForQuestion(plain.id)
        assertTrue(plainOptions.isNotEmpty())
        assertFalse(plainOptions.any { it.isOther })
        val gender = questions.values.first { it.questionShortName == "gender" }
        assertEquals(listOf(false, false, true), dao.getOptionsForQuestion(gender.id).sortedBy { it.optionQuestionIndex }.map { it.isOther })
    }
}
