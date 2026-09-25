package com.dev.salt.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.dev.salt.data.FacilityConfig
import com.dev.salt.data.SurveyDatabase
import com.dev.salt.data.User
import com.dev.salt.sync.CouponRestoreManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class FacilitySetupUiState(
    val shortCode: String = "",
    val isLoading: Boolean = false,
    val error: String? = null,
    val successMessage: String? = null
)

class FacilitySetupViewModel(
    private val database: SurveyDatabase
) : ViewModel() {
    private val _uiState = MutableStateFlow(FacilitySetupUiState())
    val uiState: StateFlow<FacilitySetupUiState> = _uiState.asStateFlow()

    fun updateShortCode(code: String) {
        _uiState.value = _uiState.value.copy(
            shortCode = code.take(6), // Limit to 6 characters
            error = null
        )
    }

    suspend fun setupFacility(onSuccess: () -> Unit) {
        if (_uiState.value.shortCode.length < 6) {
            _uiState.value = _uiState.value.copy(
                error = "Please enter a valid 6-character setup code"
            )
            return
        }

        _uiState.value = _uiState.value.copy(isLoading = true, error = null)

        withContext(Dispatchers.IO) {
            // Try to get existing server URL from global config, otherwise use default
            val existingConfig = database.appServerConfigDao().getServerConfig()
            val serverUrl = if (!existingConfig?.serverUrl.isNullOrEmpty()) {
                existingConfig!!.serverUrl
            } else {
                // Use 10.0.2.2 for Android emulator to connect to host machine's localhost
                "http://10.0.2.2:3000"
            }

            try {

                android.util.Log.d("FacilitySetup", "Connecting to server: $serverUrl")

                // Call the facility setup endpoint
                val url = URL("$serverUrl/api/sync/facility-setup")
                val connection = url.openConnection() as HttpURLConnection

                connection.apply {
                    requestMethod = "POST"
                    setRequestProperty("Content-Type", "application/json")
                    doOutput = true
                    connectTimeout = 10000
                    readTimeout = 10000
                }

                // Send the short code
                val requestBody = """{"shortCode": "${_uiState.value.shortCode}"}"""
                android.util.Log.d("FacilitySetup", "Sending request: $requestBody")
                connection.outputStream.use { it.write(requestBody.toByteArray()) }

                val responseCode = connection.responseCode
                android.util.Log.d("FacilitySetup", "Response code: $responseCode")

                val response = if (responseCode == HttpURLConnection.HTTP_OK) {
                    connection.inputStream.bufferedReader().use { it.readText() }
                } else {
                    connection.errorStream?.bufferedReader()?.use { it.readText() } ?: "Unknown error"
                }

                android.util.Log.d("FacilitySetup", "Response: $response")

                if (responseCode == HttpURLConnection.HTTP_OK) {
                    // Parse the response
                    val jsonResponse = JSONObject(response)
                    val status = jsonResponse.optString("status")

                    if (status == "success") {
                        val data = jsonResponse.getJSONObject("data")

                        // Save facility configuration
                        val facilityConfig = FacilityConfig(
                            facilityId = data.optInt("facility_id"),
                            facilityName = data.optString("facility_name"),
                            allowNonCouponParticipants = data.optBoolean("allow_non_coupon_participants", true),
                            couponsToIssue = data.optInt("coupons_to_issue", 3),
                            seedRecruitmentActive = data.optBoolean("seed_recruitment_active", false),
                            seedContactRateDays = data.optInt("seed_contact_rate_days", 7),
                            seedRecruitmentWindowMinDays = data.optInt("seed_recruitment_window_min_days", 0),
                            seedRecruitmentWindowMaxDays = data.optInt("seed_recruitment_window_max_days", 730),
                            subjectPaymentType = data.optString("subject_payment_type", "None"),
                            participationPaymentAmount = data.optDouble("participation_payment_amount", 0.0),
                            recruitmentPaymentAmount = data.optDouble("recruitment_payment_amount", 0.0),
                            paymentCurrency = data.optString("payment_currency", "USD"),
                            paymentCurrencySymbol = data.optString("payment_currency_symbol", "$"),
                            enrollmentQuota = if (data.has("enrollment_quota") && !data.isNull("enrollment_quota")) {
                                data.getInt("enrollment_quota")
                            } else {
                                null
                            },
                            serverEnrollmentCount = if (data.has("enrollment_count") && !data.isNull("enrollment_count")) {
                                data.getInt("enrollment_count")
                            } else {
                                null
                            },
                            serverEnrollmentCountTime = if (data.has("enrollment_count") && !data.isNull("enrollment_count")) {
                                System.currentTimeMillis()
                            } else {
                                null
                            },
                            lastSyncTime = System.currentTimeMillis(),
                            syncStatus = "COMPLETED"
                        )

                        database.facilityConfigDao().insertOrUpdate(facilityConfig)

                        // Save API key and server URL to global config
                        val apiKey = data.optString("api_key")
                        if (apiKey.isNotEmpty()) {
                            val serverConfig = com.dev.salt.data.AppServerConfig(
                                serverUrl = serverUrl,
                                apiKey = apiKey
                            )
                            database.appServerConfigDao().insertOrUpdate(serverConfig)
                        }

                        // Pull any coupon + completed-survey state the server has
                        // for this facility, so a tablet that's been wiped doesn't
                        // forget previously issued coupons / recruitment chains.
                        // Hard fail: if restore can't complete, roll back the
                        // facility setup so the user re-enters the setup code
                        // rather than silently losing the recovery opportunity.
                        if (apiKey.isNotEmpty()) {
                            try {
                                val restored = CouponRestoreManager(database)
                                    .restoreFromServer(serverUrl, apiKey)
                                android.util.Log.d("FacilitySetup",
                                    "Restored coupons=${restored.couponsRestored} " +
                                    "stubs=${restored.stubsRestored}")
                            } catch (restoreErr: Exception) {
                                android.util.Log.e("FacilitySetup",
                                    "Restore failed; rolling back facility setup", restoreErr)
                                database.appServerConfigDao().clearServerConfig()
                                database.facilityConfigDao().deleteAll()
                                withContext(Dispatchers.Main) {
                                    _uiState.value = _uiState.value.copy(
                                        isLoading = false,
                                        error = "Setup completed but coupon restore " +
                                                "failed: ${restoreErr.message}. " +
                                                "Please try the setup code again."
                                    )
                                }
                                return@withContext
                            }
                        }

                        withContext(Dispatchers.Main) {
                            _uiState.value = _uiState.value.copy(
                                isLoading = false,
                                successMessage = "Facility '${facilityConfig.facilityName}' configured successfully!",
                                error = null
                            )

                            // Call the success callback after a short delay on the main thread
                            kotlinx.coroutines.delay(1500)
                            onSuccess()
                        }
                    } else {
                        val errorMessage = jsonResponse.optString("message", "Setup failed")
                        withContext(Dispatchers.Main) {
                            _uiState.value = _uiState.value.copy(
                                isLoading = false,
                                error = errorMessage
                            )
                        }
                    }
                } else {
                    // Parse error response
                    try {
                        val jsonError = JSONObject(response)
                        val errorMessage = jsonError.optString("message", "Setup failed")
                        withContext(Dispatchers.Main) {
                            _uiState.value = _uiState.value.copy(
                                isLoading = false,
                                error = errorMessage
                            )
                        }
                    } catch (e: Exception) {
                        withContext(Dispatchers.Main) {
                            _uiState.value = _uiState.value.copy(
                                isLoading = false,
                                error = "Setup failed: $response"
                            )
                        }
                    }
                }
            } catch (e: Exception) {
                android.util.Log.e("FacilitySetup", "Setup failed", e)
                val errorMessage = when {
                    e is java.net.UnknownHostException -> "Cannot connect to server. Please check network connection."
                    e is java.net.ConnectException -> "Cannot connect to server at $serverUrl"
                    e is java.net.SocketTimeoutException -> "Connection timed out. Please try again."
                    e.message != null -> "Connection failed: ${e.message}"
                    else -> "Connection failed. Please check your network and try again."
                }
                withContext(Dispatchers.Main) {
                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        error = errorMessage
                    )
                }
            }
        }
    }
}

class FacilitySetupViewModelFactory(
    private val database: SurveyDatabase
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        if (modelClass.isAssignableFrom(FacilitySetupViewModel::class.java)) {
            @Suppress("UNCHECKED_CAST")
            return FacilitySetupViewModel(database) as T
        }
        throw IllegalArgumentException("Unknown ViewModel class")
    }
}