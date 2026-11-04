package com.dev.salt.upload

import com.dev.salt.data.*
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.*

data class SerializedTestResult(
    val testId: String,
    val testName: String,
    val result: String,
    val recordedAt: String
)

data class SerializedSurvey(
    val surveyId: String,
    val subjectId: String,
    val startDatetime: String,
    val language: String,
    val serverSurveyId: Long? = null, // Survey ID from management server
    val questions: List<SerializedQuestion>,
    val answers: List<SerializedAnswer>,
    val completedAt: String,
    val deviceInfo: DeviceInfo,
    val referralCouponCode: String? = null,
    val issuedCoupons: List<String> = emptyList(),
    val sampleCollected: Boolean? = null, // null=not reached, true=collected, false=refused
    val hivRapidTestResult: String? = null, // Deprecated - kept for backward compatibility
    val testResults: List<SerializedTestResult> = emptyList(), // New multi-test support
    val paymentConfirmed: Boolean? = null,
    val paymentAmount: Double? = null,
    val paymentType: String? = null,
    val paymentDate: String? = null,
    val paymentPhoneNumber: String? = null, // Phone for payment audit purposes
    val consentSignaturePath: String? = null, // Hexadecimal string of signature PNG
    val consentMessageText: String? = null // The consent text that was displayed at time of consent
)

data class SerializedQuestion(
    val id: Int,
    val questionId: Int,
    val questionShortName: String,
    val statement: String,
    val questionType: String,
    val options: List<SerializedOption>
)

data class SerializedOption(
    val id: Int,
    val text: String,
    val optionQuestionIndex: Int
)

data class SerializedAnswer(
    val questionId: Int,
    val questionShortName: String,
    val answerValue: Any?,
    val answerType: String, // "multiple_choice", "numeric", "text"
    val optionText: String? = null,
    val otherText: String? = null // free text for the question's "other" option
)

data class DeviceInfo(
    val deviceId: String,
    val appVersion: String,
    val androidVersion: String,
    val deviceModel: String
)

class SurveySerializer {
    
    private val dateFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }
    
    fun serializeSurvey(
        survey: Survey,
        questions: List<Question>,
        answers: List<Answer>,
        options: Map<Int, List<Option>>,
        deviceInfo: DeviceInfo,
        issuedCoupons: List<String> = emptyList(),
        testResults: List<TestResult> = emptyList(),
        consentMessageText: String? = null
    ): JSONObject {

        val serializedQuestions = questions.map { question ->
            SerializedQuestion(
                id = question.id,
                questionId = question.questionId,
                questionShortName = question.questionShortName,
                statement = question.statement,
                questionType = question.questionType,
                options = options[question.id]?.map { option ->
                    SerializedOption(
                        id = option.id,
                        text = option.text,
                        optionQuestionIndex = option.optionQuestionIndex
                    )
                } ?: emptyList()
            )
        }
        
        val serializedAnswers = answers.map { answer ->
            val question = questions.find { it.questionId == answer.questionId }
            if (question != null) {
                // The question schema is the authoritative source of the type.
                // The previous when-cascade inferred the type from the answer's
                // isMultiSelect/isNumeric/optionQuestionIndex flags, but those
                // flags are unset when the participant skipped the question,
                // which caused empty answers to be uploaded as answerType="text"
                // regardless of the question's actual type.
                val answerType = question.questionType
                val (answerValue, optionText) = when (answerType) {
                    "multi_select" -> Pair(answer.multiSelectIndices ?: "", null)
                    "numeric" -> Pair(answer.numericValue, null)
                    "multiple_choice" -> {
                        val option = options[question.id]?.find { it.optionQuestionIndex == answer.optionQuestionIndex }
                        Pair(answer.optionQuestionIndex, option?.text)
                    }
                    else -> Pair(answer.answerPrimaryLanguageText, null) // text and any unknown types
                }

                SerializedAnswer(
                    questionId = question.questionId,
                    questionShortName = question.questionShortName,
                    answerValue = answerValue,
                    answerType = answerType,
                    optionText = optionText,
                    otherText = if (answerType == "multiple_choice" || answerType == "multi_select")
                        answer.otherText?.takeIf { it.isNotBlank() } else null
                )
            } else {
                // Include answer even if question not found (shouldn't happen, but preserve data)
                com.dev.salt.logging.AppLogger.w("SurveySerializer", "Question not found for answer with questionId: ${answer.questionId}")
                SerializedAnswer(
                    questionId = answer.questionId,
                    questionShortName = "unknown_${answer.questionId}",
                    answerValue = answer.getValue(),
                    answerType = when {
                        answer.isMultiSelect -> "multi_select"
                        answer.isNumeric -> "numeric"
                        answer.optionQuestionIndex != null -> "multiple_choice"
                        else -> "text"
                    },
                    optionText = null
                )
            }
        }
        
        // Log sample collection status for debugging
        com.dev.salt.logging.AppLogger.d("SurveySerializer", "Survey ${survey.id} sample collection status: ${survey.sampleCollected}")

        // Serialize test results
        val serializedTestResults = testResults.map { testResult ->
            SerializedTestResult(
                testId = testResult.testId,
                testName = testResult.testName,
                result = testResult.result,
                recordedAt = dateFormat.format(Date(testResult.recordedAt))
            )
        }

        val serializedSurvey = SerializedSurvey(
            surveyId = survey.id,
            subjectId = survey.subjectId,
            startDatetime = dateFormat.format(Date(survey.startDatetime)),
            language = survey.language,
            serverSurveyId = survey.serverSurveyId,
            questions = serializedQuestions,
            answers = serializedAnswers,
            completedAt = dateFormat.format(Date()),
            deviceInfo = deviceInfo,
            referralCouponCode = survey.referralCouponCode,
            issuedCoupons = issuedCoupons,
            sampleCollected = survey.sampleCollected,
            hivRapidTestResult = survey.hivRapidTestResult, // Keep for backward compatibility
            testResults = serializedTestResults,
            paymentConfirmed = survey.paymentConfirmed,
            paymentAmount = survey.paymentAmount,
            paymentType = survey.paymentType,
            paymentDate = survey.paymentDate?.let { dateFormat.format(Date(it)) },
            paymentPhoneNumber = survey.paymentPhoneNumber,
            consentSignaturePath = survey.consentSignaturePath,
            consentMessageText = consentMessageText
        )

        return toJSON(serializedSurvey)
    }
    
    private fun toJSON(survey: SerializedSurvey): JSONObject {
        val json = JSONObject().apply {
            put("surveyId", survey.surveyId)
            put("subjectId", survey.subjectId)
            put("startDatetime", survey.startDatetime)
            put("language", survey.language)
            put("completedAt", survey.completedAt)

            // Include server survey ID if available
            survey.serverSurveyId?.let { put("serverSurveyId", it) }
            
            // Coupon information
            survey.referralCouponCode?.let { put("referralCouponCode", it) }
            if (survey.issuedCoupons.isNotEmpty()) {
                put("issuedCoupons", JSONArray().apply {
                    survey.issuedCoupons.forEach { coupon ->
                        put(coupon)
                    }
                })
            }

            // Sample collection status (always include, even if null)
            when (survey.sampleCollected) {
                true -> put("sampleCollected", true)
                false -> put("sampleCollected", false)
                null -> put("sampleCollected", JSONObject.NULL)
            }

            // HIV rapid test result (deprecated - kept for backward compatibility)
            if (survey.hivRapidTestResult != null) {
                put("hivRapidTestResult", survey.hivRapidTestResult)
            } else {
                put("hivRapidTestResult", JSONObject.NULL)
            }

            // Test results (new multi-test support)
            put("testResults", JSONArray().apply {
                survey.testResults.forEach { testResult ->
                    put(JSONObject().apply {
                        put("testId", testResult.testId)
                        put("testName", testResult.testName)
                        put("result", testResult.result)
                        put("recordedAt", testResult.recordedAt)
                    })
                }
            })

            // Payment information
            when (survey.paymentConfirmed) {
                true -> put("paymentConfirmed", true)
                false -> put("paymentConfirmed", false)
                null -> put("paymentConfirmed", JSONObject.NULL)
            }
            survey.paymentAmount?.let { put("paymentAmount", it) }
            survey.paymentType?.let { put("paymentType", it) }
            survey.paymentDate?.let { put("paymentDate", it) }
            survey.paymentPhoneNumber?.let { put("paymentPhoneNumber", it) }

            // Consent signature (hexadecimal string)
            if (survey.consentSignaturePath != null) {
                put("consentSignaturePath", survey.consentSignaturePath)
            } else {
                put("consentSignaturePath", JSONObject.NULL)
            }

            // Consent message text (the text that was displayed at time of consent)
            if (survey.consentMessageText != null) {
                put("consentMessageText", survey.consentMessageText)
            } else {
                put("consentMessageText", JSONObject.NULL)
            }

            // Device info
            put("deviceInfo", JSONObject().apply {
                put("deviceId", survey.deviceInfo.deviceId)
                put("appVersion", survey.deviceInfo.appVersion)
                put("androidVersion", survey.deviceInfo.androidVersion)
                put("deviceModel", survey.deviceInfo.deviceModel)
            })
            
            // Questions array
            put("questions", JSONArray().apply {
                survey.questions.forEach { question ->
                    put(JSONObject().apply {
                        put("id", question.id)
                        put("questionId", question.questionId)
                        put("questionShortName", question.questionShortName)
                        put("statement", question.statement)
                        put("questionType", question.questionType)
                        
                        put("options", JSONArray().apply {
                            question.options.forEach { option ->
                                put(JSONObject().apply {
                                    put("id", option.id)
                                    put("text", option.text)
                                    put("optionQuestionIndex", option.optionQuestionIndex)
                                })
                            }
                        })
                    })
                }
            })
            
            // Answers array
            put("answers", JSONArray().apply {
                survey.answers.forEach { answer ->
                    put(JSONObject().apply {
                        put("questionId", answer.questionId)
                        put("questionShortName", answer.questionShortName)
                        put("answerValue", answer.answerValue)
                        put("answerType", answer.answerType)
                        answer.optionText?.let { put("optionText", it) }
                        answer.otherText?.let { put("otherText", it) }
                    })
                }
            })
        }
        
        return json
    }
    
    fun createDeviceInfo(context: android.content.Context): DeviceInfo {
        return DeviceInfo(
            deviceId = android.provider.Settings.Secure.getString(
                context.contentResolver,
                android.provider.Settings.Secure.ANDROID_ID
            ) ?: "unknown",
            appVersion = try {
                val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
                packageInfo.versionName ?: "unknown"
            } catch (e: Exception) {
                "unknown"
            },
            androidVersion = android.os.Build.VERSION.RELEASE,
            deviceModel = "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}"
        )
    }
}