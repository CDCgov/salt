package com.dev.salt.viewmodels

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.dev.salt.data.SurveyDatabase
import com.dev.salt.data.TestConfiguration
import com.dev.salt.data.TestResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import com.dev.salt.logging.AppLogger as Log

class TestManagementViewModel(application: Application) : AndroidViewModel(application) {
    private val database = SurveyDatabase.getInstance(application)
    private val testConfigDao = database.testConfigurationDao()
    private val testResultDao = database.testResultDao()

    // UI State
    private val _enabledTests = MutableStateFlow<List<TestConfiguration>>(emptyList())
    val enabledTests: StateFlow<List<TestConfiguration>> = _enabledTests.asStateFlow()

    private val _currentTestIndex = MutableStateFlow(0)
    val currentTestIndex: StateFlow<Int> = _currentTestIndex.asStateFlow()

    private val _testResults = MutableStateFlow<List<TestResult>>(emptyList())
    val testResults: StateFlow<List<TestResult>> = _testResults.asStateFlow()

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    /**
     * Load enabled tests for a survey
     */
    fun loadEnabledTests(surveyId: Long) {
        viewModelScope.launch {
            try {
                _isLoading.value = true
                _error.value = null

                val tests = testConfigDao.getEnabledTestConfigurations(surveyId)
                _enabledTests.value = tests
                _currentTestIndex.value = 0

                Log.d("TestManagementVM", "Loaded ${tests.size} enabled tests for survey $surveyId")
            } catch (e: Exception) {
                Log.e("TestManagementVM", "Error loading enabled tests", e)
                _error.value = "Failed to load test configurations: ${e.message}"
            } finally {
                _isLoading.value = false
            }
        }
    }

    /**
     * Load test results for a survey
     */
    fun loadTestResults(surveyId: String) {
        viewModelScope.launch {
            try {
                val results = testResultDao.getTestResultsBySurveyId(surveyId)
                _testResults.value = results
                Log.d("TestManagementVM", "Loaded ${results.size} test results for survey $surveyId")
            } catch (e: Exception) {
                Log.e("TestManagementVM", "Error loading test results", e)
                _error.value = "Failed to load test results: ${e.message}"
            }
        }
    }

    /**
     * Get current test configuration
     */
    fun getCurrentTest(): TestConfiguration? {
        val tests = _enabledTests.value
        val index = _currentTestIndex.value
        return if (index < tests.size) tests[index] else null
    }

    /**
     * Move to next test
     * @return true if there is a next test, false if all tests are complete
     */
    fun moveToNextTest(): Boolean {
        val currentIndex = _currentTestIndex.value
        val tests = _enabledTests.value

        if (currentIndex < tests.size - 1) {
            _currentTestIndex.value = currentIndex + 1
            Log.d("TestManagementVM", "Moved to test ${currentIndex + 1} of ${tests.size}")
            return true
        }

        Log.d("TestManagementVM", "All tests completed")
        return false
    }

    /**
     * Check if there are more tests to perform
     */
    fun hasMoreTests(): Boolean {
        val currentIndex = _currentTestIndex.value
        val tests = _enabledTests.value
        return currentIndex < tests.size - 1
    }

    /**
     * Check if any tests are enabled
     */
    fun hasAnyTests(): Boolean {
        return _enabledTests.value.isNotEmpty()
    }

    /**
     * Get test result for a specific test
     */
    fun getTestResult(surveyId: String, testId: String, callback: (TestResult?) -> Unit) {
        viewModelScope.launch {
            try {
                val result = testResultDao.getTestResult(surveyId, testId)
                callback(result)
            } catch (e: Exception) {
                Log.e("TestManagementVM", "Error getting test result", e)
                callback(null)
            }
        }
    }

    /**
     * Save test result
     */
    fun saveTestResult(
        surveyId: String,
        testId: String,
        testName: String,
        result: String,
        onSuccess: () -> Unit,
        onError: (String) -> Unit
    ) {
        viewModelScope.launch {
            try {
                val testResult = TestResult(
                    surveyId = surveyId,
                    testId = testId,
                    testName = testName,
                    result = result,
                    recordedAt = System.currentTimeMillis()
                )
                testResultDao.insertTestResult(testResult)

                // Reload test results
                loadTestResults(surveyId)

                Log.d("TestManagementVM", "Saved test result for $testName")
                onSuccess()
            } catch (e: Exception) {
                Log.e("TestManagementVM", "Error saving test result", e)
                onError("Failed to save test result: ${e.message}")
            }
        }
    }

    /**
     * Reset to first test
     */
    fun resetToFirstTest() {
        _currentTestIndex.value = 0
        Log.d("TestManagementVM", "Reset to first test")
    }

    /**
     * Clear error
     */
    fun clearError() {
        _error.value = null
    }

    /**
     * Get total number of enabled tests
     */
    fun getTotalTestCount(): Int {
        return _enabledTests.value.size
    }

    /**
     * Get current test number (1-based)
     */
    fun getCurrentTestNumber(): Int {
        return _currentTestIndex.value + 1
    }
}
