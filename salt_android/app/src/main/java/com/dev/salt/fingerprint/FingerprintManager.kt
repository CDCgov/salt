package com.dev.salt.fingerprint

import android.content.Context
import com.dev.salt.logging.AppLogger as Log
import com.dev.salt.data.SubjectFingerprint
import com.dev.salt.data.SubjectFingerprintDao
import com.dev.salt.util.EmulatorDetector
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Manager for fingerprint operations using SecuGen Hamster Pro 20
 * Automatically selects between real SecuGen implementation and mock based on environment
 */
class FingerprintManager(
    private val fingerprintDao: SubjectFingerprintDao,
    private val context: Context? = null
) {
    companion object {
        private const val TAG = "FingerprintManager"
    }

    private val implementation: IFingerprintCapture by lazy {
        val impl = FingerprintImplFactory.create(context)
        Log.i(TAG, "Fingerprint implementation: ${impl.getImplementationType()} (${EmulatorDetector.getEnvironmentDescription()})")
        impl
    }

    /**
     * Captures a fingerprint from the device
     * @return The captured fingerprint template as ByteArray, or null if capture failed
     */
    suspend fun captureFingerprint(): ByteArray? {
        Log.d(TAG, "Starting fingerprint capture with ${implementation.getImplementationType()} implementation")
        return implementation.captureFingerprint()
    }
    
    /**
     * Checks if a fingerprint has been enrolled recently using template matching
     *
     * @param fingerprintTemplate The template of the fingerprint to check
     * @param reEnrollmentDays Number of days before re-enrollment is allowed
     * @return The matching fingerprint record if found within the window, null otherwise
     */
    suspend fun checkDuplicateEnrollment(
        fingerprintTemplate: ByteArray,
        reEnrollmentDays: Int
    ): SubjectFingerprint? {
        return withContext(Dispatchers.IO) {
            val minDate = System.currentTimeMillis() - (reEnrollmentDays * 24 * 60 * 60 * 1000L)
            val recentFingerprints = fingerprintDao.getRecentCompletedFingerprints(minDate)

            Log.i(TAG, "Checking against ${recentFingerprints.size} recent completed fingerprints")

            // For SecuGen implementation, perform template matching
            val impl = implementation
            if (impl is SecuGenFingerprintImpl) {
                var failedComparisons = 0
                for (storedFingerprint in recentFingerprints) {
                    val matchScore = impl.matchTemplatesWithScore(
                        fingerprintTemplate,
                        storedFingerprint.fingerprintTemplate
                    )

                    Log.d(TAG, "Match score: $matchScore")
                    if (matchScore == null) {
                        // One unreadable stored template is skipped, so a single corrupt
                        // record can't block all enrollment. If every comparison fails
                        // (below), the problem is the new scan or the reader: fail closed.
                        failedComparisons++
                        Log.w(TAG, "Fingerprint comparison failed for stored record ${storedFingerprint.id}")
                        continue
                    }

                    // Threshold for positive match (adjust based on security requirements)
                    // Typical values: 30-50 for normal security, 50-80 for high security
                    if (matchScore != null && matchScore >= 50) {
                        Log.i(TAG, "Duplicate enrollment found (score: $matchScore), enrolled on: ${storedFingerprint.enrollmentDate}")
                        return@withContext storedFingerprint
                    }
                }
                if (recentFingerprints.isNotEmpty() && failedComparisons == recentFingerprints.size) {
                    throw FingerprintMatchException("All ${recentFingerprints.size} fingerprint comparisons failed")
                }
            } else {
                // For mock implementation, just do byte array comparison
                for (storedFingerprint in recentFingerprints) {
                    if (fingerprintTemplate.contentEquals(storedFingerprint.fingerprintTemplate)) {
                        Log.i(TAG, "Duplicate enrollment found (mock), enrolled on: ${storedFingerprint.enrollmentDate}")
                        return@withContext storedFingerprint
                    }
                }
            }

            Log.i(TAG, "No duplicate enrollment found")
            null
        }
    }
    
    /**
     * Stores a fingerprint for a survey
     *
     * @param surveyId The ID of the survey
     * @param fingerprintTemplate The template of the fingerprint
     * @param facilityId The ID of the facility (optional)
     * @return The ID of the inserted record
     */
    suspend fun storeFingerprint(
        surveyId: String,
        fingerprintTemplate: ByteArray,
        facilityId: Int? = null
    ): Long {
        return withContext(Dispatchers.IO) {
            val fingerprint = SubjectFingerprint(
                surveyId = surveyId,
                fingerprintTemplate = fingerprintTemplate,
                enrollmentDate = System.currentTimeMillis(),
                facilityId = facilityId
            )
            
            val id = fingerprintDao.insertFingerprint(fingerprint)
            Log.i(TAG, "Fingerprint stored for survey $surveyId")
            id
        }
    }
    
    /**
     * Cleans up old fingerprint records
     * 
     * @param daysToKeep Number of days of records to keep
     */
    suspend fun cleanupOldRecords(daysToKeep: Int = 365) {
        withContext(Dispatchers.IO) {
            val cutoffDate = System.currentTimeMillis() - (daysToKeep * 24 * 60 * 60 * 1000L)
            fingerprintDao.deleteOldFingerprints(cutoffDate)
            Log.i(TAG, "Cleaned up fingerprint records older than $daysToKeep days")
        }
    }
    
    /**
     * Initializes the fingerprint device
     * @return true if initialization successful, false otherwise
     */
    suspend fun initializeDevice(): Boolean {
        Log.d(TAG, "Initializing device with ${implementation.getImplementationType()} implementation")
        return implementation.initializeDevice()
    }

    /**
     * Closes the fingerprint device connection
     */
    suspend fun closeDevice() {
        Log.d(TAG, "Closing device with ${implementation.getImplementationType()} implementation")
        implementation.closeDevice()
    }

    /**
     * Matches two fingerprint templates
     * @param template1 First template to match
     * @param template2 Second template to match
     * @return true if templates match, false otherwise
     */
    suspend fun matchTemplates(template1: ByteArray, template2: ByteArray): Boolean {
        return implementation.matchTemplates(template1, template2)
    }
}