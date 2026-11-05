package com.dev.salt.util

import com.dev.salt.logging.AppLogger as Log
import com.dev.salt.data.LabTestConfiguration
import com.dev.salt.data.SurveyDatabase
import com.dev.salt.evaluateJexlScript

/**
 * Data class representing a lab test with its JEXL evaluation result
 */
data class LabTestEvaluationResult(
    val labTest: LabTestConfiguration,
    val shouldShow: Boolean,
    val jexlCondition: String?,
    val evaluationResult: Any?
)

/**
 * Data class for debugging JEXL context
 */
data class JexlContextDebugInfo(
    val surveyAnswers: Map<String, Any>,
    val rapidTestResults: Map<String, String>,
    val combinedContext: Map<String, Any?>
)

/**
 * Utility object for evaluating JEXL conditions for lab tests.
 * Builds context from survey answers and rapid test results,
 * then evaluates each lab test's JEXL condition.
 */
object LabTestJexlEvaluator {
    private const val TAG = "LabTestJexlEvaluator"

    /**
     * Builds a JEXL context from survey answers and rapid test results.
     * Rapid test results OVERRIDE survey answers if there's a key collision.
     *
     * @param surveyId The ID of the current survey
     * @param database The database instance
     * @return JexlContextDebugInfo containing the context components for debugging
     */
    fun buildContext(
        surveyId: String,
        database: SurveyDatabase
    ): JexlContextDebugInfo {
        val surveyAnswers = mutableMapOf<String, Any>()
        val rapidTestResults = mutableMapOf<String, String>()
        val combinedContext = mutableMapOf<String, Any?>()

        // 1. Get survey answers using question short names
        val answers = database.surveyDao().getAnswersBySurveyId(surveyId)
        val survey = database.surveyDao().getSurveyById(surveyId)
        val language = survey?.language ?: "English"
        val questions = database.surveyDao().getQuestionsByLanguage(language)

        Log.d(TAG, "Building context for survey $surveyId, language: $language")
        Log.d(TAG, "Found ${answers.size} answers and ${questions.size} questions")

        for (answer in answers) {
            val question = questions.find { it.questionId == answer.questionId }
            val shortName = question?.questionShortName

            if (shortName != null) {
                val value: Any = when {
                    answer.isMultiSelect -> {
                        // Selected option indices as a List<Int> — JEXL can
                        // use contains() / =~ for membership tests.
                        answer.getSelectedIndices()
                    }
                    answer.isNumeric && answer.numericValue != null -> {
                        answer.numericValue!!
                    }
                    answer.optionQuestionIndex != null -> {
                        // Get the option's primary language text for consistency
                        // Options are keyed by question.id (Room internal id), not questionId (server index)
                        val options = question?.let { database.surveyDao().getOptionsForQuestion(it.id) } ?: emptyList()
                        val selectedOption = options.find { it.optionQuestionIndex == answer.optionQuestionIndex }
                        selectedOption?.primaryLanguageText ?: answer.optionQuestionIndex.toString()
                    }
                    answer.answerPrimaryLanguageText != null -> {
                        answer.answerPrimaryLanguageText!!
                    }
                    else -> ""
                }
                surveyAnswers[shortName] = value
                combinedContext[shortName] = value
                Log.d(TAG, "Survey answer available: $shortName")
            }
        }

        // 2. Get rapid test results - these OVERRIDE survey answers
        val testResults = database.testResultDao().getTestResultsBySurveyId(surveyId)
        Log.d(TAG, "Found ${testResults.size} rapid test results")

        for (testResult in testResults) {
            rapidTestResults[testResult.testId] = testResult.result
            combinedContext[testResult.testId] = testResult.result
            Log.d(TAG, "Rapid test result: ${testResult.testId} = ${testResult.result}")
        }

        // 3. Built-in variables (_facility_name, _facility_id, _is_seed)
        combinedContext.putAll(
            com.dev.salt.builtinJexlVariables(database.facilityConfigDao().getFacilityConfig(), survey?.referralCouponCode)
        )

        Log.d(TAG, "Combined context has ${combinedContext.size} entries: ${combinedContext.keys}")

        return JexlContextDebugInfo(
            surveyAnswers = surveyAnswers,
            rapidTestResults = rapidTestResults,
            combinedContext = combinedContext
        )
    }

    /**
     * Evaluates a single JEXL condition against the context.
     *
     * @param condition The JEXL condition string (can be null or blank)
     * @param context The combined context map
     * @return Pair of (shouldShow: Boolean, evaluationResult: Any?)
     */
    fun evaluateCondition(condition: String?, context: Map<String, Any?>): Pair<Boolean, Any?> {
        // If no condition, always show
        // Also check for literal string "null" which can occur from JSONObject.optString bug
        if (condition.isNullOrBlank() || condition == "null") {
            Log.d(TAG, "No JEXL condition - test will always show")
            return Pair(true, null)
        }

        return try {
            val result = evaluateJexlScript(condition, context)
            Log.d(TAG, "JEXL evaluation: '$condition' => $result")

            val shouldShow = when (result) {
                is Boolean -> result
                is Number -> result.toDouble() != 0.0
                null -> false // Evaluation error or undefined variable
                else -> result.toString().isNotEmpty()
            }

            Pair(shouldShow, result)
        } catch (e: Exception) {
            Log.e(TAG, "Error evaluating JEXL condition: $condition", e)
            Pair(false, "ERROR: ${e.message}")
        }
    }

    /**
     * Evaluates all active lab tests and returns which ones should be shown.
     *
     * @param surveyId The ID of the current survey
     * @param database The database instance
     * @return List of LabTestEvaluationResult with evaluation details
     */
    fun evaluateLabTests(
        surveyId: String,
        database: SurveyDatabase
    ): List<LabTestEvaluationResult> {
        val contextInfo = buildContext(surveyId, database)
        val labTests = database.labTestConfigurationDao().getActiveLabTestConfigurations()

        Log.d(TAG, "Evaluating ${labTests.size} active lab tests")
        Log.d(TAG, "=== JEXL CONTEXT DEBUG ===")
        Log.d(TAG, "Survey answers in context: ${contextInfo.surveyAnswers.size}")
        Log.d(TAG, "Rapid Test Results: ${contextInfo.rapidTestResults}")
        Log.d(TAG, "Combined Context: ${contextInfo.combinedContext}")

        return labTests.map { labTest ->
            val (shouldShow, result) = evaluateCondition(labTest.jexlCondition, contextInfo.combinedContext)

            Log.d(TAG, "Lab test '${labTest.testName}': condition='${labTest.jexlCondition}' => shouldShow=$shouldShow (result=$result)")

            LabTestEvaluationResult(
                labTest = labTest,
                shouldShow = shouldShow,
                jexlCondition = labTest.jexlCondition,
                evaluationResult = result
            )
        }
    }

    /**
     * Gets only the lab tests that should be shown (condition is true or missing).
     *
     * @param surveyId The ID of the current survey
     * @param database The database instance
     * @return List of LabTestConfiguration that should be displayed
     */
    fun getQualifyingLabTests(
        surveyId: String,
        database: SurveyDatabase
    ): List<LabTestConfiguration> {
        return evaluateLabTests(surveyId, database)
            .filter { it.shouldShow }
            .map { it.labTest }
    }

    /**
     * Checks if any lab tests should be shown for this survey.
     *
     * @param surveyId The ID of the current survey
     * @param database The database instance
     * @return true if at least one lab test should be shown
     */
    fun hasQualifyingLabTests(
        surveyId: String,
        database: SurveyDatabase
    ): Boolean {
        return getQualifyingLabTests(surveyId, database).isNotEmpty()
    }

    /**
     * Gets full debug information for all lab test evaluations.
     *
     * @param surveyId The ID of the current survey
     * @param database The database instance
     * @return Pair of (JexlContextDebugInfo, List<LabTestEvaluationResult>)
     */
    fun getDebugInfo(
        surveyId: String,
        database: SurveyDatabase
    ): Pair<JexlContextDebugInfo, List<LabTestEvaluationResult>> {
        val contextInfo = buildContext(surveyId, database)
        val labTests = database.labTestConfigurationDao().getActiveLabTestConfigurations()

        val results = labTests.map { labTest ->
            val (shouldShow, result) = evaluateCondition(labTest.jexlCondition, contextInfo.combinedContext)
            LabTestEvaluationResult(
                labTest = labTest,
                shouldShow = shouldShow,
                jexlCondition = labTest.jexlCondition,
                evaluationResult = result
            )
        }

        return Pair(contextInfo, results)
    }
}
