package com.dev.salt.sync

import android.content.Context
import com.dev.salt.logging.AppLogger as Log
import com.dev.salt.util.hasActiveNetwork
import com.dev.salt.data.FacilityConfig
import com.dev.salt.data.SurveyDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class FacilityConfigSyncManager(
    private val database: SurveyDatabase
) {
    companion object {
        private const val TAG = "FacilityConfigSync"
    }

    private val appServerConfigDao = database.appServerConfigDao()
    private val facilityConfigDao = database.facilityConfigDao()
    
    /**
     * Validates API key by making a lightweight request to the server.
     * Returns true if API key is valid, false otherwise.
     * On 401/403 errors, returns false to trigger re-setup.
     * With no network connectivity, returns true immediately (skipping the
     * request) - an unreachable server cannot mean a revoked key.
     */
    suspend fun validateApiKey(context: Context): Boolean {
        return withContext(Dispatchers.IO) {
            try {
                val serverConfig = getServerConfig()
                if (serverConfig == null) {
                    Log.e(TAG, "No server configuration found")
                    return@withContext false
                }

                // No network at all -> we cannot receive a 401/403, so this
                // cannot be a revoked key. Return true immediately rather than
                // waiting out the connection timeout.
                if (!hasActiveNetwork(context)) {
                    Log.d(TAG, "No active network - skipping API key validation (offline)")
                    return@withContext true
                }

                val (serverUrl, apiKey) = serverConfig
                val url = URL("$serverUrl/api/sync/survey/version")
                val connection = url.openConnection() as HttpURLConnection

                try {
                    connection.requestMethod = "GET"
                    connection.setRequestProperty("X-API-Key", apiKey)
                    connection.setRequestProperty("Accept", "application/json")
                    connection.connectTimeout = 10000
                    connection.readTimeout = 10000

                    val responseCode = connection.responseCode
                    Log.d(TAG, "API key validation response code: $responseCode")

                    when (responseCode) {
                        HttpURLConnection.HTTP_OK -> {
                            Log.d(TAG, "API key is valid")
                            return@withContext true
                        }
                        HttpURLConnection.HTTP_UNAUTHORIZED,
                        HttpURLConnection.HTTP_FORBIDDEN -> {
                            Log.w(TAG, "API key is invalid (HTTP $responseCode), need new setup code")
                            // Don't clear config - just return false to navigate to setup screen
                            return@withContext false
                        }
                        else -> {
                            Log.e(TAG, "Server returned unexpected code: $responseCode")
                            return@withContext true // Don't trigger re-setup on other errors
                        }
                    }
                } finally {
                    connection.disconnect()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error validating API key", e)
                return@withContext true // Don't trigger re-setup on network errors
            }
        }
    }

    suspend fun syncFacilityConfig(): Boolean {
        return withContext(Dispatchers.IO) {
            try {
                Log.d(TAG, "Starting facility config sync")

                // Get server configuration
                val serverConfig = getServerConfig()
                if (serverConfig == null) {
                    Log.e(TAG, "No server configuration found")
                    return@withContext false
                }

                val (serverUrl, apiKey) = serverConfig
                val fullUrl = "$serverUrl/api/sync/facility/config"

                Log.d(TAG, "Fetching facility config from: $fullUrl")

                // Make HTTP request
                val url = URL(fullUrl)
                val connection = url.openConnection() as HttpURLConnection

                try {
                    connection.requestMethod = "GET"
                    connection.setRequestProperty("X-API-Key", apiKey)
                    connection.setRequestProperty("Accept", "application/json")
                    connection.connectTimeout = 30000
                    connection.readTimeout = 30000

                    val responseCode = connection.responseCode
                    Log.d(TAG, "Response code: $responseCode")

                    if (responseCode == HttpURLConnection.HTTP_OK) {
                        val response = connection.inputStream.bufferedReader().readText()
                        val jsonResponse = JSONObject(response)
                        
                        if (jsonResponse.getString("status") == "success") {
                            val data = jsonResponse.getJSONObject("data")
                            
                            // Parse facility configuration
                            val facilityId = data.getInt("facility_id")
                            val facilityName = data.getString("facility_name")
                            val allowNonCoupon = data.getBoolean("allow_non_coupon_participants")
                            val couponsToIssue = data.getInt("coupons_to_issue")
                            val seedRecruitmentActive = data.optBoolean("seed_recruitment_active", false)
                            val seedContactRateDays = data.optInt("seed_contact_rate_days", 7)
                            val seedRecruitmentWindowMinDays = data.optInt("seed_recruitment_window_min_days", 0)
                            val seedRecruitmentWindowMaxDays = data.optInt("seed_recruitment_window_max_days", 730)

                            // Parse payment configuration
                            val subjectPaymentType = data.optString("subject_payment_type", "None")
                            val participationPaymentAmount = data.optDouble("participation_payment_amount", 0.0)
                            val recruitmentPaymentAmount = data.optDouble("recruitment_payment_amount", 0.0)
                            val paymentCurrency = data.optString("payment_currency", "USD")
                            val paymentCurrencySymbol = data.optString("payment_currency_symbol", "$")

                            // Enrollment quota: absent or null = no limit
                            val enrollmentQuota = if (data.has("enrollment_quota") && !data.isNull("enrollment_quota")) {
                                data.getInt("enrollment_quota")
                            } else {
                                null
                            }
                            // Server's live enrolled count for this facility (absent on older servers)
                            val serverEnrollmentCount = if (data.has("enrollment_count") && !data.isNull("enrollment_count")) {
                                data.getInt("enrollment_count")
                            } else {
                                null
                            }

                            // Save to database
                            val config = FacilityConfig(
                                id = 1,
                                facilityId = facilityId,
                                facilityName = facilityName,
                                allowNonCouponParticipants = allowNonCoupon,
                                couponsToIssue = couponsToIssue,
                                seedRecruitmentActive = seedRecruitmentActive,
                                seedContactRateDays = seedContactRateDays,
                                seedRecruitmentWindowMinDays = seedRecruitmentWindowMinDays,
                                seedRecruitmentWindowMaxDays = seedRecruitmentWindowMaxDays,
                                subjectPaymentType = subjectPaymentType,
                                participationPaymentAmount = participationPaymentAmount,
                                recruitmentPaymentAmount = recruitmentPaymentAmount,
                                paymentCurrency = paymentCurrency,
                                paymentCurrencySymbol = paymentCurrencySymbol,
                                enrollmentQuota = enrollmentQuota,
                                serverEnrollmentCount = serverEnrollmentCount,
                                serverEnrollmentCountTime = serverEnrollmentCount?.let { System.currentTimeMillis() },
                                lastSyncTime = System.currentTimeMillis(),
                                syncStatus = "SUCCESS"
                            )
                            
                            facilityConfigDao.insertFacilityConfig(config)
                            
                            Log.i(TAG, "Facility config synced successfully: $facilityName (ID: $facilityId)")
                            Log.i(TAG, "Settings: Allow non-coupon=$allowNonCoupon, Coupons to issue=$couponsToIssue")
                            
                            return@withContext true
                        } else {
                            Log.e(TAG, "Server returned error status")
                            return@withContext false
                        }
                    } else {
                        Log.e(TAG, "Server returned error code: $responseCode")
                        return@withContext false
                    }
                } finally {
                    connection.disconnect()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error syncing facility config", e)
                return@withContext false
            }
        }
    }
    
    private fun getServerConfig(): Pair<String, String>? {
        val config = appServerConfigDao.getServerConfig()
        val serverUrl = config?.serverUrl?.takeIf { it.isNotBlank() }
        val apiKey = config?.apiKey?.takeIf { it.isNotBlank() }

        return if (serverUrl != null && apiKey != null) {
            Log.d(TAG, "Using server config: URL=$serverUrl")
            Pair(serverUrl, apiKey)
        } else {
            Log.e(TAG, "No server configuration found")
            null
        }
    }
    
    fun getFacilityConfig(): FacilityConfig {
        // Return config from database or default values
        return facilityConfigDao.getFacilityConfig() ?: FacilityConfig(
            id = 1,
            allowNonCouponParticipants = true,
            couponsToIssue = 3
        )
    }
}