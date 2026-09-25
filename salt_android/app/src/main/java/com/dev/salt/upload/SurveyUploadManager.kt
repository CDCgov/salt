package com.dev.salt.upload

import android.content.Context
import com.dev.salt.logging.AppLogger as Log
import com.dev.salt.data.*
import com.dev.salt.session.SessionManagerInstance
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.min
import kotlin.math.pow

sealed class UploadResult {
    object Success : UploadResult()
    data class NetworkError(val message: String) : UploadResult()
    data class ServerError(val code: Int, val message: String) : UploadResult()
    data class ConfigurationError(val message: String) : UploadResult()
    data class UnknownError(val message: String) : UploadResult()
}

class SurveyUploadManager(
    private val context: Context,
    private val database: SurveyDatabase
) {
    private val serializer = SurveySerializer()
    private val uploadStateDao = database.uploadStateDao()
    private val appServerConfigDao = database.appServerConfigDao()
    private val surveyDao = database.surveyDao()
    private val sessionManager = SessionManagerInstance.instance
    
    companion object {
        private const val TAG = "SurveyUploadManager"
        private const val MAX_RETRY_ATTEMPTS = 5
        private const val BASE_RETRY_DELAY_MS = 1000L
        private const val CONNECTION_TIMEOUT_MS = 30000
        private const val READ_TIMEOUT_MS = 30000
    }
    
    suspend fun uploadSurvey(surveyId: String): UploadResult {
        return withContext(Dispatchers.IO) {
            try {
                Log.d(TAG, "Starting upload for survey: $surveyId")
                
                // Get or create upload state first to ensure survey is tracked
                var uploadState = uploadStateDao.getUploadState(surveyId)
                if (uploadState == null) {
                    uploadState = SurveyUploadState(
                        surveyId = surveyId,
                        uploadStatus = UploadStatus.PENDING.name
                    )
                    uploadStateDao.insertUploadState(uploadState)
                }
                
                // Get server configuration from global settings
                val serverConfig = appServerConfigDao.getServerConfig()
                if (serverConfig == null || serverConfig.serverUrl.isBlank() || serverConfig.apiKey.isBlank()) {
                    Log.e(TAG, "No server configuration found for upload")
                    updateUploadState(surveyId, UploadStatus.FAILED, "Server not configured")
                    return@withContext UploadResult.ConfigurationError("Server not configured. Please configure server settings.")
                }
                
                // Disabled retry limit check since WorkManager is disabled
                // Check retry limits
                // if (uploadState.attemptCount >= MAX_RETRY_ATTEMPTS) {
                //     Log.w(TAG, "Max retry attempts reached for survey: $surveyId")
                //     updateUploadState(surveyId, UploadStatus.FAILED, "Max retry attempts exceeded")
                //     return@withContext UploadResult.UnknownError("Maximum retry attempts exceeded")
                // }
                
                // Mark as uploading
                updateUploadState(surveyId, UploadStatus.UPLOADING, null)
                
                // Get survey data
                val survey = surveyDao.getSurveyById(surveyId)
                if (survey == null) {
                    Log.e(TAG, "Survey not found: $surveyId")
                    updateUploadState(surveyId, UploadStatus.FAILED, "Survey not found in database")
                    return@withContext UploadResult.UnknownError("Survey not found")
                }
                
                // Populate survey with questions and answers
                survey.populateFields(surveyDao)
                
                // Get options for all questions (keyed by Room internal id)
                val options = survey.questions.associate { question ->
                    question.id to surveyDao.getOptionsForQuestion(question.id)
                }
                
                // Get issued coupons for this survey
                val couponDao = database.couponDao()
                val issuedCoupons = couponDao.getCouponsIssuedToSurvey(surveyId).map { it.couponCode }
                Log.d(TAG, "Found ${issuedCoupons.size} issued coupons for survey $surveyId: $issuedCoupons")

                // Get test results for this survey
                val testResultDao = database.testResultDao()
                val testResults = testResultDao.getTestResultsBySurveyId(surveyId)
                Log.d(TAG, "Found ${testResults.size} test results for survey $surveyId")

                // Get consent message text for audit trail
                val systemMessageDao = database.systemMessageDao()
                var consentMessageText: String? = null
                try {
                    // Try to get consent message in survey's language, with fallbacks
                    var message = systemMessageDao.getSystemMessage("consent_agreement", survey.language)
                    if (message == null) {
                        message = systemMessageDao.getSystemMessage("consent_agreement", "en")
                    }
                    if (message == null) {
                        val allMessages = systemMessageDao.getAllMessagesForKey("consent_agreement")
                        message = allMessages.firstOrNull()
                    }
                    consentMessageText = message?.messageText
                    Log.d(TAG, "Consent message found: ${consentMessageText?.take(50) ?: "null"}...")
                } catch (e: Exception) {
                    Log.w(TAG, "Could not retrieve consent message for upload", e)
                }

                // Create device info
                val deviceInfo = serializer.createDeviceInfo(context)

                // Serialize survey to JSON including coupon information, test results, and consent message
                val jsonData = serializer.serializeSurvey(survey, survey.questions, survey.answers, options, deviceInfo, issuedCoupons, testResults, consentMessageText)
                
                // Build the upload URL (append endpoint to base URL)
                val uploadUrl = "${serverConfig.serverUrl}/api/sync/survey/upload"

                // Perform HTTP upload
                val uploadResult = performHttpUpload(uploadUrl, jsonData, serverConfig.apiKey)
                
                when (uploadResult) {
                    is UploadResult.Success -> {
                        Log.i(TAG, "Successfully uploaded survey: $surveyId")
                        val uploadedAt = System.currentTimeMillis()
                        uploadStateDao.markUploadCompleted(surveyId, UploadStatus.COMPLETED.name, uploadedAt)
                        // Survey-level marker for the enrollment quota (upload-state rows get cleaned up)
                        database.surveyDao().markSurveyUploaded(surveyId, uploadedAt)
                    }
                    else -> {
                        Log.w(TAG, "Upload failed for survey: $surveyId, result: $uploadResult")
                        val errorMessage = when (uploadResult) {
                            is UploadResult.NetworkError -> uploadResult.message
                            is UploadResult.ServerError -> "Server error ${uploadResult.code}: ${uploadResult.message}"
                            is UploadResult.ConfigurationError -> uploadResult.message
                            is UploadResult.UnknownError -> uploadResult.message
                            else -> "Unknown error"
                        }
                        updateUploadState(surveyId, UploadStatus.FAILED, errorMessage)
                    }
                }
                
                uploadResult
                
            } catch (e: Exception) {
                Log.e(TAG, "Exception during survey upload: $surveyId", e)
                updateUploadState(surveyId, UploadStatus.FAILED, "Upload exception: ${e.message}")
                UploadResult.UnknownError("Upload failed with exception: ${e.message}")
            }
        }
    }
    
    private fun updateUploadState(surveyId: String, status: UploadStatus, errorMessage: String?) {
        val currentState = uploadStateDao.getUploadState(surveyId)
        val newAttemptCount = if (status == UploadStatus.FAILED || status == UploadStatus.UPLOADING) {
            (currentState?.attemptCount ?: 0) + 1
        } else {
            currentState?.attemptCount ?: 0
        }
        
        uploadStateDao.updateUploadAttempt(
            surveyId = surveyId,
            status = status.name,
            attemptTime = System.currentTimeMillis(),
            attemptCount = newAttemptCount,
            errorMessage = errorMessage
        )
    }
    
    private suspend fun performHttpUpload(serverUrl: String, jsonData: JSONObject, apiKey: String?): UploadResult {
        return withContext(Dispatchers.IO) {
            try {
                Log.d(TAG, "Performing HTTP upload to: $serverUrl")
                
                val url = URL(serverUrl)
                val connection = url.openConnection() as HttpURLConnection
                
                connection.apply {
                    requestMethod = "POST"
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    setRequestProperty("Accept", "application/json")
                    if (!apiKey.isNullOrBlank()) {
                        // Use X-API-Key header like the sync endpoints
                        setRequestProperty("X-API-Key", apiKey)
                    }
                    setRequestProperty("User-Agent", "SALT-Android-Client/1.0")
                    
                    connectTimeout = CONNECTION_TIMEOUT_MS
                    readTimeout = READ_TIMEOUT_MS
                    doOutput = true
                }
                
                // Write JSON data
                OutputStreamWriter(connection.outputStream).use { writer ->
                    writer.write(jsonData.toString())
                    writer.flush()
                }
                
                // Check response
                val responseCode = connection.responseCode
                Log.d(TAG, "Upload response code: $responseCode")
                
                when (responseCode) {
                    in 200..299 -> {
                        Log.i(TAG, "Upload successful")
                        UploadResult.Success
                    }
                    in 400..499 -> {
                        val errorMessage = try {
                            connection.errorStream?.bufferedReader()?.readText() ?: "Client error"
                        } catch (e: Exception) {
                            "Client error"
                        }
                        Log.w(TAG, "Client error during upload: $responseCode - $errorMessage")
                        UploadResult.ServerError(responseCode, errorMessage)
                    }
                    in 500..599 -> {
                        val errorMessage = try {
                            connection.errorStream?.bufferedReader()?.readText() ?: "Server error"
                        } catch (e: Exception) {
                            "Server error"
                        }
                        Log.w(TAG, "Server error during upload: $responseCode - $errorMessage")
                        UploadResult.ServerError(responseCode, errorMessage)
                    }
                    else -> {
                        Log.w(TAG, "Unexpected response code: $responseCode")
                        UploadResult.UnknownError("Unexpected response code: $responseCode")
                    }
                }
                
            } catch (e: java.net.SocketTimeoutException) {
                Log.w(TAG, "Upload timeout", e)
                UploadResult.NetworkError("Connection timeout")
            } catch (e: java.net.UnknownHostException) {
                Log.w(TAG, "Unknown host", e)
                UploadResult.NetworkError("Server not reachable: ${e.message}")
            } catch (e: java.net.ConnectException) {
                Log.w(TAG, "Connection failed", e)
                UploadResult.NetworkError("Connection failed: ${e.message}")
            } catch (e: Exception) {
                Log.e(TAG, "Network error during upload", e)
                UploadResult.NetworkError("Network error: ${e.message}")
            }
        }
    }
    
    suspend fun retryPendingUploads(): List<Pair<String, UploadResult>> {
        return withContext(Dispatchers.IO) {
            val pendingUploads = uploadStateDao.getPendingUploads()
            Log.i(TAG, "Found ${pendingUploads.size} pending uploads")
            
            val results = mutableListOf<Pair<String, UploadResult>>()
            
            for (uploadState in pendingUploads) {
                // Apply exponential backoff
                val timeSinceLastAttempt = System.currentTimeMillis() - (uploadState.lastAttemptTime ?: 0)
                val requiredDelay = calculateBackoffDelay(uploadState.attemptCount)
                
                if (timeSinceLastAttempt < requiredDelay) {
                    Log.d(TAG, "Skipping retry for ${uploadState.surveyId} - backoff period not met")
                    continue
                }
                
                val result = uploadSurvey(uploadState.surveyId)
                results.add(uploadState.surveyId to result)
                
                // Small delay between retries to avoid overwhelming the server
                delay(1000)
            }
            
            results
        }
    }
    
    private fun calculateBackoffDelay(attemptCount: Int): Long {
        return (BASE_RETRY_DELAY_MS * 2.0.pow(min(attemptCount, 6).toDouble())).toLong()
    }
    
    suspend fun cleanupOldUploads(olderThanDays: Int = 30) {
        withContext(Dispatchers.IO) {
            val cutoffTime = System.currentTimeMillis() - (olderThanDays * 24 * 60 * 60 * 1000L)
            uploadStateDao.cleanupOldCompletedUploads(cutoffTime)
            Log.i(TAG, "Cleaned up completed uploads older than $olderThanDays days")
        }
    }
    
    suspend fun getUploadStatistics(): UploadStatistics {
        return withContext(Dispatchers.IO) {
            val allStates = uploadStateDao.getAllUploadStates()
            val pending = allStates.count { it.uploadStatus == UploadStatus.PENDING.name }
            val uploading = allStates.count { it.uploadStatus == UploadStatus.UPLOADING.name }
            val completed = allStates.count { it.uploadStatus == UploadStatus.COMPLETED.name }
            val failed = allStates.count { it.uploadStatus == UploadStatus.FAILED.name }
            
            UploadStatistics(
                totalSurveys = allStates.size,
                pendingUploads = pending,
                uploadingCount = uploading,
                completedUploads = completed,
                failedUploads = failed
            )
        }
    }
}

data class UploadStatistics(
    val totalSurveys: Int,
    val pendingUploads: Int,
    val uploadingCount: Int,
    val completedUploads: Int,
    val failedUploads: Int
)