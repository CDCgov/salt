package com.dev.salt.util

import com.dev.salt.logging.AppLogger as Log
import com.dev.salt.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

class SeedRecruitmentManager(
    private val database: SurveyDatabase
) {
    companion object {
        private const val TAG = "SeedRecruitmentManager"
    }
    
    private val seedRecruitmentDao = database.seedRecruitmentDao()
    private val facilityConfigDao = database.facilityConfigDao()
    private val couponDao = database.couponDao()
    private val couponGenerator = CouponGenerator(couponDao, database.surveyDao())
    
    /**
     * Check if seed recruitment is currently allowed based on facility config and timing
     */
    suspend fun isRecruitmentAllowed(): Boolean = withContext(Dispatchers.IO) {
        val config = facilityConfigDao.getFacilityConfig()
        Log.d(TAG, "Facility config: $config")
        
        if (config == null) {
            Log.d(TAG, "No facility config found")
            return@withContext false
        }
        
        Log.d(TAG, "Seed recruitment active: ${config.seedRecruitmentActive}")
        if (!config.seedRecruitmentActive) {
            Log.d(TAG, "Seed recruitment is not active")
            return@withContext false
        }
        
        // Check if there's an active recruitment within the contact rate window
        val contactRateMillis = TimeUnit.DAYS.toMillis(config.seedContactRateDays.toLong())
        val minDate = System.currentTimeMillis() - contactRateMillis
        
        val activeRecruitment = seedRecruitmentDao.getActiveRecruitment(minDate)
        if (activeRecruitment != null) {
            Log.d(TAG, "Active recruitment exists, not yet sent")
            return@withContext true
        }
        
        // Check if we've sent a message recently
        val recentlySent = seedRecruitmentDao.getRecentlySentRecruitments(minDate)
        if (recentlySent.isNotEmpty()) {
            Log.d(TAG, "Message sent recently, waiting for contact rate period")
            return@withContext false
        }
        
        // Check if there are eligible subjects
        val hasEligible = hasEligibleSubjects()
        Log.d(TAG, "Has eligible subjects: $hasEligible")
        
        return@withContext hasEligible
    }
    
    /**
     * Get or select a subject for recruitment
     */
    suspend fun getOrSelectSubject(): SeedRecruitment? = withContext(Dispatchers.IO) {
        val config = facilityConfigDao.getFacilityConfig() ?: return@withContext null
        
        // Check for existing active recruitment
        val contactRateMillis = TimeUnit.DAYS.toMillis(config.seedContactRateDays.toLong())
        val minDate = System.currentTimeMillis() - contactRateMillis
        
        val existingRecruitment = seedRecruitmentDao.getActiveRecruitment(minDate)
        if (existingRecruitment != null) {
            Log.d(TAG, "Returning existing active recruitment")
            return@withContext existingRecruitment
        }
        
        // Select new subject
        val minWindowMillis = TimeUnit.DAYS.toMillis(config.seedRecruitmentWindowMinDays.toLong())
        val maxWindowMillis = TimeUnit.DAYS.toMillis(config.seedRecruitmentWindowMaxDays.toLong())
        
        val now = System.currentTimeMillis()
        val maxDate = now - minWindowMillis  // Most recent allowed
        val minDateWindow = now - maxWindowMillis  // Oldest allowed
        
        val eligibleSubject = seedRecruitmentDao.getRandomEligibleSubject(
            minDate = minDateWindow,
            maxDate = maxDate,
            recentContactDate = minDate
        )
        
        if (eligibleSubject == null) {
            Log.w(TAG, "No eligible subjects found")
            return@withContext null
        }
        
        // Generate coupon for this recruitment
        val couponCode = couponGenerator.generateUniqueCouponCode()
        
        // Create coupon entry
        val coupon = Coupon(
            couponCode = couponCode,
            status = CouponStatus.ISSUED.name,
            issuedToSurveyId = "SEED_${eligibleSubject.id}",
            issuedDate = System.currentTimeMillis()
        )
        couponDao.insertCoupon(coupon)
        
        // Determine contact type and info
        val contactType = if (!eligibleSubject.contactPhone.isNullOrBlank()) "phone" else "email"
        val contactInfo = if (contactType == "phone") 
            eligibleSubject.contactPhone ?: "" 
        else 
            eligibleSubject.contactEmail ?: ""
        
        // Create recruitment record
        val recruitment = SeedRecruitment(
            selectedSubjectId = eligibleSubject.id,
            selectedDate = System.currentTimeMillis(),
            contactInfo = contactInfo,
            contactType = contactType,
            couponCode = couponCode,
            messageSent = false,
            sentDate = null
        )
        
        val recruitmentId = seedRecruitmentDao.insertRecruitment(recruitment)
        Log.i(TAG, "Created new seed recruitment: $recruitmentId for subject ${eligibleSubject.id}")
        
        return@withContext recruitment.copy(id = recruitmentId.toInt())
    }
    
    /**
     * Mark a recruitment message as sent
     */
    suspend fun markMessageSent(recruitmentId: Int): Boolean = withContext(Dispatchers.IO) {
        try {
            seedRecruitmentDao.markMessageSent(recruitmentId, System.currentTimeMillis())
            Log.i(TAG, "Marked recruitment $recruitmentId as sent")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to mark recruitment as sent", e)
            false
        }
    }
    
    /**
     * Check if there are any eligible subjects for recruitment
     */
    private suspend fun hasEligibleSubjects(): Boolean = withContext(Dispatchers.IO) {
        val config = facilityConfigDao.getFacilityConfig() ?: return@withContext false
        
        val minWindowMillis = TimeUnit.DAYS.toMillis(config.seedRecruitmentWindowMinDays.toLong())
        val maxWindowMillis = TimeUnit.DAYS.toMillis(config.seedRecruitmentWindowMaxDays.toLong())
        val contactRateMillis = TimeUnit.DAYS.toMillis(config.seedContactRateDays.toLong())
        
        val now = System.currentTimeMillis()
        val maxDate = now - minWindowMillis
        val minDate = now - maxWindowMillis
        val recentContactDate = now - contactRateMillis
        
        Log.d(TAG, "Looking for eligible subjects:")
        Log.d(TAG, "  - Window: ${config.seedRecruitmentWindowMinDays} to ${config.seedRecruitmentWindowMaxDays} days")
        Log.d(TAG, "  - Date range: ${java.util.Date(minDate)} to ${java.util.Date(maxDate)}")
        Log.d(TAG, "  - Excluding those contacted after: ${java.util.Date(recentContactDate)}")
        
        // Debug: Check all surveys with contact info
        val allSurveys = database.surveyDao().getAllSurveysWithContact()
        Log.d(TAG, "All surveys with contact info: ${allSurveys.size}")
        allSurveys.forEach { survey ->
            Log.d(TAG, "  Survey ${survey.id}: consent=${survey.contactConsent}, hasPhone=${!survey.contactPhone.isNullOrBlank()}, hasEmail=${!survey.contactEmail.isNullOrBlank()}, date=${java.util.Date(survey.startDatetime)}")
        }
        
        val eligibleSubject = seedRecruitmentDao.getRandomEligibleSubject(
            minDate = minDate,
            maxDate = maxDate,
            recentContactDate = recentContactDate
        )
        
        Log.d(TAG, "Found eligible subject: ${eligibleSubject != null}")
        if (eligibleSubject != null) {
            Log.d(TAG, "  - Subject ID: ${eligibleSubject.id}")
            Log.d(TAG, "  - Contact method: ${if (!eligibleSubject.contactPhone.isNullOrBlank()) "phone" else "email"}")
        }
        
        eligibleSubject != null
    }
    
    /**
     * Generate recruitment message based on contact type
     */
    fun generateRecruitmentMessage(
        recruitment: SeedRecruitment,
        facilityName: String
    ): String {
        return if (recruitment.contactType == "phone") {
            generateSmsMessage(facilityName, recruitment.couponCode)
        } else {
            generateEmailMessage(facilityName, recruitment.couponCode)
        }
    }
    
    private fun generateSmsMessage(facilityName: String, couponCode: String): String {
        return """
            Hello! You previously participated in our health survey at $facilityName. We'd like to invite you back for a follow-up survey.
            
            Your participation helps improve health services in our community.
            
            Please visit us at your convenience with this coupon code: $couponCode
            
            Thank you!
        """.trimIndent()
    }
    
    private fun generateEmailMessage(facilityName: String, couponCode: String): String {
        return """
            Subject: Follow-up Survey Invitation
            
            Dear Participant,
            
            Thank you for your previous participation in our health survey at $facilityName.
            
            We would like to invite you to participate in a follow-up survey. Your continued participation helps us better understand and improve health services in our community.
            
            Please visit our facility at your convenience and present this coupon code: $couponCode
            
            Best regards,
            $facilityName Survey Team
        """.trimIndent()
    }
}