package com.dev.salt.sync

import android.content.Context
import android.util.Base64
import com.dev.salt.logging.AppLogger as Log
import com.dev.salt.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Extension function to safely get a String or null from JSONObject.
 * Unlike optString(key, null), this properly returns null when the
 * JSON field is missing or contains JSON null.
 *
 * The standard optString(key, null) returns the literal string "null"
 * instead of actual null, which causes issues with JEXL evaluation.
 */
private fun JSONObject.getStringOrNull(key: String): String? =
    if (this.has(key) && !this.isNull(key)) {
        this.getString(key)
    } else {
        null
    }

/**
 * Result of checking for survey updates with detailed status information.
 */
sealed class SurveyCheckResult {
    object NeedsUpdate : SurveyCheckResult()
    object UpToDate : SurveyCheckResult()
    /** Network unreachable - normal for offline operation, not alarming */
    object Unreachable : SurveyCheckResult()
    /** Actual error - connection refused, auth failure, server error - indicates a problem */
    data class Error(val reason: String) : SurveyCheckResult()
}

class SurveySyncManager(private val context: Context) {
    private val database = SurveyDatabase.getInstance(context)
    private val surveyDao = database.surveyDao()
    private val syncMetadataDao = database.syncMetadataDao()
    private val appServerConfigDao = database.appServerConfigDao()

    // Get server configuration from global settings
    private fun getServerConfig(): Pair<String, String>? {
        val config = appServerConfigDao.getServerConfig()

        return if (config != null) {
            Log.d("SurveySyncManager", "Using server config: URL=${config.serverUrl}, API Key=${config.apiKey.take(10)}...")
            Pair(config.serverUrl, config.apiKey)
        } else {
            Log.e("SurveySyncManager", "No server configuration found. Please configure server settings.")
            null
        }
    }
    
    init {
        // Ensure sync metadata exists
        if (syncMetadataDao.getSyncMetadata() == null) {
            syncMetadataDao.insertSyncMetadata(SyncMetadata())
        }
        
        // Ensure audio directory exists
        val audioDir = File(context.filesDir, "audio")
        if (!audioDir.exists()) {
            audioDir.mkdirs()
        }
    }
    
    private fun calculateMD5(input: String): String {
        val md = MessageDigest.getInstance("MD5")
        val digest = md.digest(input.toByteArray())
        return digest.joinToString("") { "%02x".format(it) }
    }
    
    private fun saveAudioFromBase64(base64Data: String?): String {
        if (base64Data.isNullOrEmpty()) return ""

        try {
            // Extract base64 portion if it's a data URL
            val base64Content = if (base64Data.startsWith("data:")) {
                base64Data.substringAfter("base64,")
            } else {
                base64Data
            }

            // Calculate MD5 hash of the content
            val hash = calculateMD5(base64Content)
            val filename = "$hash.mp3"
            val audioDir = File(context.filesDir, "audio")
            val audioFile = File(audioDir, filename)

            // If file already exists, no need to save again
            if (audioFile.exists()) {
                Log.d("SurveySyncManager", "Audio file already exists: $filename")
                return filename
            }

            // Decode and save the audio
            val audioBytes = Base64.decode(base64Content, Base64.DEFAULT)
            FileOutputStream(audioFile).use { fos ->
                fos.write(audioBytes)
                fos.flush()
                fos.fd.sync() // Force write to disk
            }

            Log.d("SurveySyncManager", "Saved audio file: $filename")
            return filename

        } catch (e: Exception) {
            Log.e("SurveySyncManager", "Error saving audio", e)
            return ""
        }
    }

    suspend fun checkForSurveyUpdate(): Boolean = withContext(Dispatchers.IO) {
        try {
            val config = getServerConfig()
            if (config == null) {
                Log.e("SurveySyncManager", "Cannot check for updates: No server configuration")
                return@withContext false
            }

            val (serverUrl, apiKey) = config
            val url = URL("$serverUrl/api/sync/survey/version")
            val connection = url.openConnection() as HttpURLConnection
            connection.requestMethod = "GET"
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("X-API-Key", apiKey)
            connection.connectTimeout = 10000
            connection.readTimeout = 10000

            if (connection.responseCode == HttpURLConnection.HTTP_OK) {
                val response = connection.inputStream.bufferedReader().use { it.readText() }
                val jsonResponse = JSONObject(response)

                if (jsonResponse.getString("status") == "success") {
                    val data = jsonResponse.getJSONObject("data")
                    val serverChecksum = data.optString("checksum", "")
                    val serverLastModified = data.optLong("last_modified", 0)

                    // Get current local checksum from sync metadata
                    val syncMetadata = syncMetadataDao.getSyncMetadata()
                    val localChecksum = syncMetadata?.surveyChecksum ?: ""

                    // Compare checksums to determine if update is needed
                    val needsUpdate = serverChecksum.isNotEmpty() && serverChecksum != localChecksum

                    Log.d("SurveySyncManager", "Version check: serverChecksum=$serverChecksum, localChecksum=$localChecksum, needsUpdate=$needsUpdate")
                    return@withContext needsUpdate
                } else {
                    Log.e("SurveySyncManager", "Server returned error status")
                    return@withContext false
                }
            } else {
                Log.e("SurveySyncManager", "Server returned ${connection.responseCode}")
                return@withContext false
            }
        } catch (e: Exception) {
            Log.e("SurveySyncManager", "Error checking for survey updates", e)
            return@withContext false
        }
    }

    /**
     * Check for survey updates with detailed status information.
     * Returns SurveyCheckResult indicating whether an update is needed, survey is up to date, or an error occurred.
     */
    suspend fun checkForSurveyUpdateWithStatus(): SurveyCheckResult = withContext(Dispatchers.IO) {
        try {
            val config = getServerConfig()
            if (config == null) {
                // No config is not alarming - just means not set up yet
                return@withContext SurveyCheckResult.Unreachable
            }

            val (serverUrl, apiKey) = config
            val url = URL("$serverUrl/api/sync/survey/version")
            val connection = url.openConnection() as HttpURLConnection
            connection.requestMethod = "GET"
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("X-API-Key", apiKey)
            connection.connectTimeout = 5000
            connection.readTimeout = 5000

            val responseCode = connection.responseCode
            if (responseCode == HttpURLConnection.HTTP_OK) {
                val response = connection.inputStream.bufferedReader().use { it.readText() }
                val jsonResponse = JSONObject(response)

                if (jsonResponse.getString("status") == "success") {
                    val data = jsonResponse.getJSONObject("data")
                    val serverChecksum = data.optString("checksum", "")
                    val syncMetadata = syncMetadataDao.getSyncMetadata()
                    val localChecksum = syncMetadata?.surveyChecksum ?: ""

                    return@withContext if (serverChecksum.isNotEmpty() && serverChecksum != localChecksum) {
                        SurveyCheckResult.NeedsUpdate
                    } else {
                        SurveyCheckResult.UpToDate
                    }
                } else {
                    return@withContext SurveyCheckResult.Error("Server returned error status")
                }
            } else {
                // HTTP errors are real problems
                return@withContext when (responseCode) {
                    HttpURLConnection.HTTP_UNAUTHORIZED, HttpURLConnection.HTTP_FORBIDDEN ->
                        SurveyCheckResult.Error("Authentication failed")
                    in 500..599 ->
                        SurveyCheckResult.Error("Server error ($responseCode)")
                    else ->
                        SurveyCheckResult.Error("Server returned $responseCode")
                }
            }
        } catch (e: java.io.IOException) {
            // Any network I/O failure (host unreachable, connection refused,
            // timeout, no route, DNS, TLS) is an offline/unreachable condition,
            // not a hard error. Surface it as a soft "no server connection".
            return@withContext SurveyCheckResult.Unreachable
        } catch (e: Exception) {
            return@withContext SurveyCheckResult.Error(e.message ?: "Unknown error")
        }
    }

    suspend fun downloadAndReplaceSurvey(): Result<String> = withContext(Dispatchers.IO) {
        try {
            // Check if server is configured
            val config = getServerConfig()
            if (config == null) {
                val errorMsg = "Server not configured. Please configure server settings first."
                syncMetadataDao.updateSyncStatus("ERROR", errorMsg)
                return@withContext Result.failure(Exception(errorMsg))
            }
            
            // Update sync status to syncing
            syncMetadataDao.updateSyncStatus("SYNCING")
            
            // Download survey from server
            val surveyData = downloadSurveyFromServer()

            if (surveyData != null) {
                // Clear existing data
                clearExistingData()

                // Parse and insert new data
                insertSurveyData(surveyData)

                // Extract and save checksum from metadata
                val checksum = surveyData.optJSONObject("metadata")?.optString("checksum") ?: ""

                // Update sync metadata with checksum and success status
                syncMetadataDao.updateSurveyChecksum(checksum)
                syncMetadataDao.updateSyncStatus("SUCCESS")
                syncMetadataDao.updateLastSyncSuccess(System.currentTimeMillis())

                Result.success("Survey downloaded successfully")
            } else {
                syncMetadataDao.updateSyncStatus("ERROR", "Failed to download survey")
                Result.failure(Exception("Failed to download survey"))
            }
        } catch (e: Exception) {
            Log.e("SurveySyncManager", "Error downloading survey", e)
            syncMetadataDao.updateSyncStatus("ERROR", e.message)
            Result.failure(e)
        }
    }
    
    private fun downloadSurveyFromServer(): JSONObject? {
        return try {
            val config = getServerConfig()
            if (config == null) {
                Log.e("SurveySyncManager", "Cannot download survey: No server configuration")
                return null
            }
            
            val (serverUrl, apiKey) = config
            val url = URL("$serverUrl/api/sync/survey/download")
            val connection = url.openConnection() as HttpURLConnection
            connection.requestMethod = "GET"
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("X-API-Key", apiKey) // Add API key header
            connection.connectTimeout = 30000
            connection.readTimeout = 30000
            
            if (connection.responseCode == HttpURLConnection.HTTP_OK) {
                val response = connection.inputStream.bufferedReader().use { it.readText() }
                val jsonResponse = JSONObject(response)
                
                if (jsonResponse.getString("status") == "success") {
                    jsonResponse.getJSONObject("data")
                } else {
                    null
                }
            } else {
                Log.e("SurveySyncManager", "Server returned ${connection.responseCode}")
                null
            }
        } catch (e: Exception) {
            Log.e("SurveySyncManager", "Network error", e)
            null
        }
    }
    
    private fun clearExistingData() {
        // Clear all questions and options using bulk delete
        database.runInTransaction {
            surveyDao.deleteAllOptions()
            surveyDao.deleteAllQuestions()
        }
    }
    
    private fun insertSurveyData(data: JSONObject) {
        database.runInTransaction {
            try {
                // Parse survey metadata including eligibility script and server survey ID
                var eligibilityScript: String? = null
                var couponCountScript: String? = null
                var serverSurveyId: Long? = null
                if (data.has("survey")) {
                    val surveyJson = data.getJSONObject("survey")
                    eligibilityScript = if (surveyJson.has("eligibility_script")) {
                        surveyJson.getString("eligibility_script")
                    } else {
                        null
                    }
                    couponCountScript = if (surveyJson.has("coupon_count_script") && !surveyJson.isNull("coupon_count_script")) {
                        surveyJson.getString("coupon_count_script").takeIf { it.isNotBlank() }
                    } else {
                        null
                    }
                    serverSurveyId = if (surveyJson.has("id") && !surveyJson.isNull("id")) {
                        surveyJson.getLong("id")
                    } else {
                        null
                    }
                    Log.d("SurveySyncManager", "Parsed eligibility script: $eligibilityScript, serverSurveyId: $serverSurveyId")
                }

                // Parse survey configuration (including eligibility script and server survey ID)
                if (data.has("survey_config")) {
                    val configJson = data.getJSONObject("survey_config")
                    Log.d("SurveySyncManager", "=== RAW SURVEY_CONFIG FROM SERVER ===")
                    Log.d("SurveySyncManager", "Full survey_config JSON: ${configJson.toString()}")
                    Log.d("SurveySyncManager", "Has 'contact_info_enabled' key: ${configJson.has("contact_info_enabled")}")
                    if (configJson.has("contact_info_enabled")) {
                        Log.d("SurveySyncManager", "Raw contact_info_enabled value: ${configJson.get("contact_info_enabled")} (type: ${configJson.get("contact_info_enabled")?.javaClass?.simpleName})")
                    }
                    Log.d("SurveySyncManager", "Has 'staff_eligibility_screening' key: ${configJson.has("staff_eligibility_screening")}")
                    if (configJson.has("staff_eligibility_screening")) {
                        Log.d("SurveySyncManager", "Raw staff_eligibility_screening value: ${configJson.get("staff_eligibility_screening")} (type: ${configJson.get("staff_eligibility_screening")?.javaClass?.simpleName})")
                    }

                    // Helper function to parse boolean values that might come as int (0/1) or boolean (true/false)
                    fun parseBoolean(json: org.json.JSONObject, key: String, default: Boolean = false): Boolean {
                        return when {
                            !json.has(key) -> default
                            json.isNull(key) -> default
                            else -> {
                                val value = json.get(key)
                                when (value) {
                                    is Boolean -> value
                                    is Int -> value == 1
                                    is String -> value.equals("true", ignoreCase = true) || value == "1"
                                    else -> default
                                }
                            }
                        }
                    }

                    val surveyConfig = SurveyConfig(
                        surveyName = configJson.getStringOrNull("survey_name"),
                        serverSurveyId = serverSurveyId,  // Store server survey ID in SurveyConfig
                        fingerprintEnabled = parseBoolean(configJson, "fingerprint_enabled"),
                        reEnrollmentDays = configJson.optInt("re_enrollment_days", 90),
                        lastSyncTime = System.currentTimeMillis(),
                        eligibilityScript = eligibilityScript,  // Store eligibility script in SurveyConfig
                        couponCountScript = couponCountScript,
                        hivRapidTestEnabled = parseBoolean(configJson, "hiv_rapid_test_enabled"),
                        contactInfoEnabled = parseBoolean(configJson, "contact_info_enabled"),
                        staffEligibilityScreening = parseBoolean(configJson, "staff_eligibility_screening"),
                        rapidTestSamplesAfterEligibility = parseBoolean(configJson, "rapid_test_samples_after_eligibility", true),
                        paymentAuditPhoneEnabled = parseBoolean(configJson, "payment_audit_phone_enabled")
                    )
                    database.surveyConfigDao().insertSurveyConfig(surveyConfig)
                    Log.d("SurveySyncManager", "Survey config updated: serverSurveyId=${surveyConfig.serverSurveyId}, fingerprint=${surveyConfig.fingerprintEnabled}, reEnrollmentDays=${surveyConfig.reEnrollmentDays}, eligibilityScript=${surveyConfig.eligibilityScript}, couponCountScript=${surveyConfig.couponCountScript}, contactInfoEnabled=${surveyConfig.contactInfoEnabled}, staffEligibilityScreening=${surveyConfig.staffEligibilityScreening}")
                }
                
                // Parse and save sections
                if (data.has("sections")) {
                    // Clear existing sections
                    database.sectionDao().deleteAllSections()

                    val sectionsArray = data.getJSONArray("sections")
                    for (i in 0 until sectionsArray.length()) {
                        val sectionJson = sectionsArray.getJSONObject(i)
                        val section = Section(
                            id = sectionJson.getInt("id"),
                            surveyId = sectionJson.getInt("survey_id"),
                            sectionIndex = sectionJson.getInt("section_index"),
                            sectionType = sectionJson.getString("section_type"),
                            name = sectionJson.getString("name"),
                            description = sectionJson.getStringOrNull("description")
                        )
                        database.sectionDao().insertSection(section)
                        Log.d("SurveySyncManager", "Inserted section: ${section.name} (type: ${section.sectionType})")
                    }
                }

                // Map to track original question ID to language-specific question IDs
                val questionIdMap = mutableMapOf<Pair<Int, String>, Int>() // (originalId, language) -> newId

                // Parse questions
                val questionsArray = data.getJSONArray("questions")
                for (i in 0 until questionsArray.length()) {
                    val questionJson = questionsArray.getJSONObject(i)
                    val originalQuestionId = questionJson.getInt("id")
                    
                    // Check if we have multilingual support
                    if (questionJson.has("question_text_json")) {
                        val textJson = questionJson.getJSONObject("question_text_json")
                        // optJSONObject -> null when the key is missing OR its
                        // value is JSON null (a survey with no audio). .has()
                        // alone is true for a JSON null and would then crash.
                        val audioJson = questionJson.optJSONObject("audio_files_json")
                        
                        // Create a question for each language
                        val languages = textJson.keys()
                        var questionIdCounter = originalQuestionId * 1000 // Multiply to avoid ID conflicts
                        
                        while (languages.hasNext()) {
                            val language = languages.next()
                            val questionText = textJson.getString(language)
                            
                            // Handle audio files for this language
                            var audioFileName = ""
                            if (audioJson != null && audioJson.has(language)) {
                                try {
                                    val audioData = audioJson.optString(language, "")
                                    if (audioData.isNotEmpty()) {
                                        audioFileName = saveAudioFromBase64(audioData)
                                    }
                                } catch (e: Exception) {
                                    Log.e("SurveySyncManager", "Error processing $language audio", e)
                                }
                            }
                            
                            val newQuestionId = questionIdCounter++
                            questionIdMap[Pair(originalQuestionId, language)] = newQuestionId
                            
                            val question = Question(
                                id = newQuestionId,
                                questionId = questionJson.getInt("question_index"),  // Use question_index for ordering
                                questionShortName = questionJson.optString("short_name", "q${originalQuestionId}"),
                                statement = questionText,
                                audioFileName = audioFileName,
                                questionLanguage = language,  // Use the actual language name
                                primaryLanguageText = questionText,
                                questionType = questionJson.optString("question_type", "multiple_choice"),
                                preScript = questionJson.getStringOrNull("pre_script"),
                                validationScript = questionJson.getStringOrNull("validation_script"),
                                validationErrorText = "Invalid Answer",
                                minSelections = if (questionJson.has("min_selections") && !questionJson.isNull("min_selections"))
                                    questionJson.getInt("min_selections") else null,
                                maxSelections = if (questionJson.has("max_selections") && !questionJson.isNull("max_selections"))
                                    questionJson.getInt("max_selections") else null,
                                skipToScript = questionJson.getStringOrNull("skip_to_script"),
                                skipToTarget = questionJson.getStringOrNull("skip_to_target"),
                                sectionId = if (questionJson.has("section_id") && !questionJson.isNull("section_id"))
                                    questionJson.getInt("section_id") else null
                            )
                            surveyDao.insertQuestion(question)
                        }
                    } else {
                        // Fallback for non-multilingual questions
                        val questionText = questionJson.optString("question_text", "Question $i")
                        questionIdMap[Pair(originalQuestionId, "English")] = originalQuestionId
                        
                        val question = Question(
                            id = originalQuestionId,
                            questionId = questionJson.getInt("question_index"),  // Use question_index for ordering
                            questionShortName = questionJson.optString("short_name", "q${originalQuestionId}"),
                            statement = questionText,
                            audioFileName = "",
                            questionLanguage = "English",  // Default to English
                            primaryLanguageText = questionText,
                            questionType = questionJson.optString("question_type", "multiple_choice"),
                            preScript = questionJson.getStringOrNull("pre_script"),
                            validationScript = questionJson.getStringOrNull("validation_script"),
                            validationErrorText = "Invalid Answer",
                            minSelections = if (questionJson.has("min_selections") && !questionJson.isNull("min_selections"))
                                questionJson.getInt("min_selections") else null,
                            maxSelections = if (questionJson.has("max_selections") && !questionJson.isNull("max_selections"))
                                questionJson.getInt("max_selections") else null,
                            skipToScript = questionJson.getStringOrNull("skip_to_script"),
                            skipToTarget = questionJson.getStringOrNull("skip_to_target"),
                            sectionId = if (questionJson.has("section_id") && !questionJson.isNull("section_id"))
                                questionJson.getInt("section_id") else null
                        )
                        surveyDao.insertQuestion(question)
                    }
                }
                
                // Parse options
                val optionsArray = data.getJSONArray("options")
                for (i in 0 until optionsArray.length()) {
                    val optionJson = optionsArray.getJSONObject(i)
                    val originalQuestionId = optionJson.getInt("question_id")
                    
                    // Check if we have multilingual support
                    if (optionJson.has("option_text_json")) {
                        val textJson = optionJson.getJSONObject("option_text_json")
                        val audioJson = optionJson.optJSONObject("audio_files_json")
                        
                        // Create an option for each language
                        val languages = textJson.keys()
                        var optionIdCounter = optionJson.getInt("id") * 1000 // Multiply to avoid ID conflicts
                        
                        while (languages.hasNext()) {
                            val language = languages.next()
                            val optionText = textJson.getString(language)
                            
                            // Get the mapped question ID for this language
                            val mappedQuestionId = questionIdMap[Pair(originalQuestionId, language)] ?: originalQuestionId
                            
                            // Handle audio files for this language
                            var audioFileName = ""
                            if (audioJson != null && audioJson.has(language)) {
                                try {
                                    val audioData = audioJson.optString(language, "")
                                    if (audioData.isNotEmpty()) {
                                        audioFileName = saveAudioFromBase64(audioData)
                                    }
                                } catch (e: Exception) {
                                    Log.e("SurveySyncManager", "Error processing $language option audio", e)
                                }
                            }
                            
                            val option = Option(
                                id = optionIdCounter++,
                                questionId = mappedQuestionId,  // Use the mapped question ID
                                text = optionText,
                                audioFileName = audioFileName,
                                optionQuestionIndex = optionJson.optInt("option_index", i),
                                language = language,  // Use the actual language name
                                primaryLanguageText = optionText
                            )
                            surveyDao.insertOption(option)
                        }
                    } else {
                        // Fallback for non-multilingual options
                        val optionText = optionJson.optString("option_text", "Option $i")
                        val mappedQuestionId = questionIdMap[Pair(originalQuestionId, "English")] ?: originalQuestionId
                        
                        val option = Option(
                            id = optionJson.getInt("id"),
                            questionId = mappedQuestionId,  // Use the mapped question ID
                            text = optionText,
                            audioFileName = "",
                            optionQuestionIndex = optionJson.optInt("option_index", i),
                            language = "English",  // Default to English
                            primaryLanguageText = optionText
                        )
                        surveyDao.insertOption(option)
                    }
                }

                // Parse system messages
                if (data.has("messages")) {
                    val messagesArray = data.getJSONArray("messages")
                    val systemMessageDao = database.systemMessageDao()

                    // Clear existing messages
                    systemMessageDao.deleteAllSystemMessages()

                    for (i in 0 until messagesArray.length()) {
                        val messageJson = messagesArray.getJSONObject(i)
                        val messageKey = messageJson.getString("message_key")

                        // Check if we have multilingual support
                        if (messageJson.has("text")) {
                            val textJson = messageJson.getJSONObject("text")
                            val audioJson = if (messageJson.has("audio")) {
                                messageJson.getJSONObject("audio")
                            } else null

                            // Create a message for each language
                            val languages = textJson.keys()
                            while (languages.hasNext()) {
                                val language = languages.next()
                                val messageText = textJson.getString(language)

                                // Handle audio files for this language
                                var audioFileName: String? = null
                                if (audioJson != null && audioJson.has(language)) {
                                    try {
                                        val audioData = audioJson.optString(language, "")
                                        if (audioData.isNotEmpty()) {
                                            audioFileName = saveAudioFromBase64(audioData)
                                        }
                                    } catch (e: Exception) {
                                        Log.e("SurveySyncManager", "Error processing message audio for $language", e)
                                    }
                                }

                                val systemMessage = SystemMessage(
                                    messageKey = messageKey,
                                    messageText = messageText,
                                    audioFileName = audioFileName,
                                    language = language,
                                    messageType = messageJson.optString("message_type", "system")
                                )
                                systemMessageDao.insertSystemMessage(systemMessage)
                                Log.d("SurveySyncManager", "Inserted system message: $messageKey ($language)")
                            }
                        }
                    }
                    Log.d("SurveySyncManager", "Inserted ${messagesArray.length()} system messages")
                }

                // Parse test configurations
                if (data.has("test_configurations")) {
                    val testConfigsArray = data.getJSONArray("test_configurations")
                    val testConfigDao = database.testConfigurationDao()

                    // Clear existing test configurations
                    testConfigDao.deleteAllTestConfigurations()

                    for (i in 0 until testConfigsArray.length()) {
                        val testConfigJson = testConfigsArray.getJSONObject(i)

                        // Get survey_id from survey object if available, otherwise use 1 as default
                        val surveyId = if (data.has("survey")) {
                            data.getJSONObject("survey").optLong("id", 1)
                        } else {
                            Log.e("SurveySyncManager", "ERROR: No survey object in JSON data, falling back to survey ID 1. This may cause test configuration mismatches.")
                            1L
                        }

                        val testConfiguration = TestConfiguration(
                            surveyId = surveyId,
                            testId = testConfigJson.getString("test_id"),
                            testName = testConfigJson.getString("test_name"),
                            enabled = testConfigJson.optInt("enabled", 0) == 1, // SQLite stores boolean as 0/1
                            displayOrder = testConfigJson.getInt("display_order")
                        )
                        testConfigDao.insertTestConfiguration(testConfiguration)
                        Log.d("SurveySyncManager", "Inserted test configuration: ${testConfiguration.testName} (enabled: ${testConfiguration.enabled})")
                    }
                    Log.d("SurveySyncManager", "Inserted ${testConfigsArray.length()} test configurations")
                }

                // Parse lab test configurations
                if (data.has("lab_tests")) {
                    val labTestsArray = data.getJSONArray("lab_tests")
                    val labTestConfigDao = database.labTestConfigurationDao()

                    // Clear existing lab test configurations
                    labTestConfigDao.deleteAllLabTestConfigurations()

                    for (i in 0 until labTestsArray.length()) {
                        val labTestJson = labTestsArray.getJSONObject(i)

                        // Parse options array to JSON string if present
                        val optionsString = if (labTestJson.has("options") && !labTestJson.isNull("options")) {
                            labTestJson.getJSONArray("options").toString()
                        } else {
                            null
                        }

                        val labTestConfiguration = LabTestConfiguration(
                            id = labTestJson.getLong("id"),
                            testName = labTestJson.getString("test_name"),
                            testCode = labTestJson.getStringOrNull("test_code"),
                            testType = labTestJson.getString("test_type"),
                            options = optionsString,
                            minValue = if (labTestJson.has("min_value") && !labTestJson.isNull("min_value"))
                                labTestJson.getDouble("min_value") else null,
                            maxValue = if (labTestJson.has("max_value") && !labTestJson.isNull("max_value"))
                                labTestJson.getDouble("max_value") else null,
                            unit = labTestJson.getStringOrNull("unit"),
                            jexlCondition = labTestJson.getStringOrNull("jexl_condition"),
                            isActive = labTestJson.optInt("is_active", 1) == 1,
                            displayOrder = labTestJson.optInt("display_order", 0)
                        )
                        labTestConfigDao.insertLabTestConfiguration(labTestConfiguration)
                        Log.d("SurveySyncManager", "Inserted lab test configuration: ${labTestConfiguration.testName} (jexl: ${labTestConfiguration.jexlCondition})")
                    }
                    Log.d("SurveySyncManager", "Inserted ${labTestsArray.length()} lab test configurations")
                }

                Log.d("SurveySyncManager", "Inserted ${questionsArray.length()} questions and ${optionsArray.length()} options")
            } catch (e: Exception) {
                Log.e("SurveySyncManager", "Error parsing survey data", e)
                throw e
            }
        }
    }
}