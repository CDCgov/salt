package com.dev.salt

import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.dev.salt.data.Option
import com.dev.salt.data.Question
import com.dev.salt.data.SurveyDatabase
import com.dev.salt.data.SystemMessage
import com.dev.salt.upload.DeviceInfo
import com.dev.salt.upload.SurveySerializer
import com.dev.salt.viewmodel.SurveyViewModel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * "Other, specify" options (SALT_IMPROVEMENT_PLAN.md item 4): text box,
 * no auto-advance on single choice, clearing on deselect, JEXL
 * `<short_name>_other`, persistence and upload serialization.
 */
@RunWith(AndroidJUnit4::class)
class OtherSpecifyTest {
    @get:Rule
    val composeRule = createComposeRule()

    private lateinit var db: SurveyDatabase

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        db = Room.inMemoryDatabaseBuilder(context, SurveyDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        val dao = db.surveyDao()
        fun question(id: Int, shortName: String, type: String) = Question(
            id = id, questionId = id, questionShortName = shortName, statement = "$shortName?",
            audioFileName = "", questionLanguage = "en", primaryLanguageText = "$shortName?",
            questionType = type
        )
        fun option(id: Int, questionId: Int, index: Int, text: String, isOther: Boolean = false) = Option(
            id = id, questionId = questionId, text = text, audioFileName = "",
            optionQuestionIndex = index, language = "en", primaryLanguageText = text, isOther = isOther
        )
        dao.insertQuestion(question(1, "gender", "multiple_choice"))
        dao.insertOption(option(1001, 1, 0, "Male"))
        dao.insertOption(option(1002, 1, 1, "Female"))
        dao.insertOption(option(1003, 1, 2, "Gender other", isOther = true))
        dao.insertQuestion(question(2, "drugs", "multi_select"))
        dao.insertOption(option(2001, 2, 0, "Alpha"))
        dao.insertOption(option(2002, 2, 1, "Beta"))
        dao.insertOption(option(2003, 2, 2, "Drug other", isOther = true))
        dao.insertQuestion(question(3, "plain", "multiple_choice"))
        dao.insertOption(option(3001, 3, 0, "Yes"))
        dao.insertOption(option(3002, 3, 1, "No"))
        dao.insertQuestion(question(4, "age", "numeric"))
    }

    @After
    fun tearDown() {
        db.close()
    }

    private fun startSurvey(): SurveyViewModel {
        lateinit var vm: SurveyViewModel
        composeRule.runOnUiThread { vm = SurveyViewModel(db) }
        composeRule.setContent { SurveyScreen(vm, rememberCoroutineScope()) }
        composeRule.waitUntil(5_000) { vm.currentQuestion.value != null }
        return vm
    }

    private fun waitForQuestion(vm: SurveyViewModel, index: Int) {
        composeRule.waitUntil(5_000) { vm.currentQuestionIndex == index }
        composeRule.waitForIdle()
    }

    private fun textBoxShown(label: String = "Please specify") =
        composeRule.onAllNodesWithText(label).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun otherSpecifyFlow() {
        val vm = startSurvey()
        assertEquals(0, vm.currentQuestionIndex)
        assertFalse("no box before other is selected", textBoxShown())

        // Single choice: tapping the other option selects it and stays on the question.
        composeRule.onNodeWithText("Gender other").performClick()
        composeRule.waitForIdle()
        assertEquals("other option must not auto-advance", 0, vm.currentQuestionIndex)
        assertTrue("box shown under selected other option", textBoxShown())
        composeRule.onNode(hasSetTextAction()).performTextInput("discard me")

        // Choosing a different option advances (as before) and discards the text.
        composeRule.onNodeWithText("Female").performClick()
        waitForQuestion(vm, 1)
        assertNull(vm.survey!!.answers[0].otherText)
        assertNull(vm.buildJexlContext()["gender_other"])
        assertTrue("gender_other is defined even when null", vm.buildJexlContext().containsKey("gender_other"))

        // Back, pick other again: the box is empty.
        composeRule.onNodeWithText("Previous").performClick()
        waitForQuestion(vm, 0)
        assertFalse(textBoxShown())
        composeRule.onNodeWithText("Gender other").performClick()
        composeRule.waitForIdle()
        assertTrue(textBoxShown())
        composeRule.onNode(hasSetTextAction()).performTextInput("  non-binary  ")
        composeRule.onNodeWithText("Next").performClick()
        waitForQuestion(vm, 1)
        assertEquals("non-binary", vm.survey!!.answers[0].otherText)
        assertEquals(2, vm.buildJexlContext()["gender"])
        assertEquals("non-binary", vm.buildJexlContext()["gender_other"])

        // Multi-select: ticking other shows the box, unticking clears it.
        composeRule.onNodeWithText("Alpha").performClick()
        composeRule.waitForIdle()
        assertFalse(textBoxShown())
        composeRule.onNodeWithText("Drug other").performClick()
        composeRule.waitForIdle()
        assertTrue(textBoxShown())
        composeRule.onNode(hasSetTextAction()).performTextInput("kratom")
        composeRule.onNodeWithText("Drug other").performClick()
        composeRule.waitForIdle()
        assertFalse("box hidden after unticking other", textBoxShown())
        composeRule.onNodeWithText("Drug other").performClick()
        composeRule.waitForIdle()
        assertTrue(textBoxShown())
        composeRule.onNode(hasSetTextAction()).performTextInput("k2")
        composeRule.onNodeWithText("Next").performClick()
        waitForQuestion(vm, 2)
        assertEquals("k2", vm.survey!!.answers[1].otherText)
        assertEquals(listOf(0, 2), vm.buildJexlContext()["drugs"])
        assertEquals("k2", vm.buildJexlContext()["drugs_other"])
        assertFalse("no _other variable for a question without an other option",
            vm.buildJexlContext().containsKey("plain_other"))

        // JEXL scripts can use the variable.
        val ctx = vm.buildJexlContext()
        assertEquals(true, evaluateJexlScript("gender == 2 && gender_other == 'non-binary'", ctx))
        assertEquals(true, evaluateJexlScript("2 =~ drugs && drugs_other != null", ctx))

        // Going back shows the saved text.
        composeRule.onNodeWithText("Previous").performClick()
        waitForQuestion(vm, 1)
        assertTrue(textBoxShown())
        composeRule.onNodeWithText("k2").assertExists()

        // Blank text is stored as null.
        composeRule.onNodeWithText("Next").performClick()
        waitForQuestion(vm, 2)
        composeRule.onNodeWithText("Previous").performClick()
        waitForQuestion(vm, 1)
        composeRule.runOnUiThread { vm.answerOtherText("   ") }
        assertNull(vm.survey!!.answers[1].otherText)
        assertNull(vm.buildJexlContext()["drugs_other"])
        composeRule.runOnUiThread { vm.answerOtherText("k2") }

        // Saved to the database (saves run on Dispatchers.IO).
        val surveyId = vm.survey!!.id
        composeRule.waitUntil(5_000) {
            db.surveyDao().getAnswersBySurveyId(surveyId).firstOrNull { it.questionId == 2 }?.otherText == "k2"
        }
        val saved = db.surveyDao().getAnswersBySurveyId(surveyId).associateBy { it.questionId }
        assertEquals("non-binary", saved[1]?.otherText)

        // Upload JSON carries otherText only where there is one.
        val questions = vm.survey!!.questions
        val options = questions.associate { it.id to db.surveyDao().getOptionsForQuestion(it.id) }
        val json = SurveySerializer().serializeSurvey(
            vm.survey!!, questions, vm.survey!!.answers, options,
            DeviceInfo("test", "test", "15", "test")
        )
        val answers = json.getJSONArray("answers")
        val byName = (0 until answers.length()).map { answers.getJSONObject(it) }
            .associateBy { it.getString("questionShortName") }
        assertEquals("non-binary", byName["gender"]!!.getString("otherText"))
        assertEquals("k2", byName["drugs"]!!.getString("otherText"))
        assertFalse(byName["plain"]!!.has("otherText"))
    }

    @Test
    fun promptComesFromSystemMessage() {
        db.systemMessageDao().insertSystemMessage(
            SystemMessage(messageKey = "other_specify_prompt", messageText = "Tell us more", language = "en")
        )
        val vm = startSurvey()
        composeRule.onNodeWithText("Gender other").performClick()
        composeRule.waitForIdle()
        assertEquals(0, vm.currentQuestionIndex)
        assertTrue(textBoxShown("Tell us more"))
        assertFalse(textBoxShown("Please specify"))
    }
}
