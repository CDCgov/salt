package com.dev.salt.data
import androidx.room.*
import androidx.room.OnConflictStrategy
import java.util.UUID
import net.sqlcipher.database.SQLiteDatabase
import net.sqlcipher.database.SupportFactory
import com.dev.salt.security.DatabaseKeyManager

@Entity(tableName = "sync_metadata")
data class SyncMetadata(
    @PrimaryKey
    val id: Int = 1, // Single row for sync status
    @ColumnInfo(name = "last_sync_time") val lastSyncTime: Long = 0,
    @ColumnInfo(name = "sync_status") val syncStatus: String = "PENDING",
    @ColumnInfo(name = "last_error") val lastError: String? = null,
    @ColumnInfo(name = "survey_checksum") val surveyChecksum: String? = null
)

@Entity(tableName = "survey_config")
data class SurveyConfig(
    @PrimaryKey
    val id: Int = 1, // Single row for survey configuration
    @ColumnInfo(name = "survey_name") val surveyName: String? = null,
    @ColumnInfo(name = "server_survey_id") val serverSurveyId: Long? = null,
    @ColumnInfo(name = "fingerprint_enabled") val fingerprintEnabled: Boolean = false,
    @ColumnInfo(name = "re_enrollment_days") val reEnrollmentDays: Int = 90,
    @ColumnInfo(name = "last_sync_time") val lastSyncTime: Long? = null,
    @ColumnInfo(name = "eligibility_script") val eligibilityScript: String? = null,
    @ColumnInfo(name = "hiv_rapid_test_enabled") val hivRapidTestEnabled: Boolean = false,
    @ColumnInfo(name = "contact_info_enabled", defaultValue = "0") val contactInfoEnabled: Boolean = false,
    @ColumnInfo(name = "staff_eligibility_screening", defaultValue = "0") val staffEligibilityScreening: Boolean = false,
    @ColumnInfo(name = "rapid_test_samples_after_eligibility", defaultValue = "1") val rapidTestSamplesAfterEligibility: Boolean = true,
    @ColumnInfo(name = "payment_audit_phone_enabled", defaultValue = "0") val paymentAuditPhoneEnabled: Boolean = false,
    // Optional JEXL expression evaluated at survey completion; can lower the number of
    // coupons issued below the facility ceiling. See CouponCountResolver.
    @ColumnInfo(name = "coupon_count_script") val couponCountScript: String? = null
)

@Entity(tableName = "system_messages", primaryKeys = ["messageKey", "language"])
data class SystemMessage(
    val messageKey: String,
    @ColumnInfo(name = "message_text") val messageText: String,
    @ColumnInfo(name = "audio_file_name") val audioFileName: String? = null,
    @ColumnInfo(name = "language") val language: String = "en",
    @ColumnInfo(name = "message_type") val messageType: String = "system"
)

@Entity(tableName = "sections")
data class Section(
    @PrimaryKey val id: Int,
    @ColumnInfo(name = "survey_id") val surveyId: Int,
    @ColumnInfo(name = "section_index") val sectionIndex: Int,
    @ColumnInfo(name = "section_type") val sectionType: String, // 'eligibility', 'survey', 'main', 'conclusion'
    @ColumnInfo(name = "name") val name: String,
    @ColumnInfo(name = "description") val description: String?
)

@Entity(tableName = "questions")
data class Question(
    @PrimaryKey val id: Int,
    @ColumnInfo(name = "question_id") val questionId: Int,
    @ColumnInfo(name = "question_short_name") val questionShortName: String,
    @ColumnInfo(name = "statement") var statement: String,
    @ColumnInfo(name = "audio_file_name") var audioFileName: String,
    @ColumnInfo(name = "question_language") var questionLanguage: String,
    @ColumnInfo(name = "primary_language_text") var primaryLanguageText: String,
    @ColumnInfo(name = "question_type") var questionType: String = "multiple_choice",
    @ColumnInfo(name = "pre_script") var preScript: String? = null, // a script to run before the question is asked
    @ColumnInfo(name = "validation_script") var validationScript: String? = null, // a script to determine if an answer value is valid
    @ColumnInfo(name = "validation_error_text") var validationErrorText: String? = "Invalid Answer", // a script to determine if an answer value is valid
    @ColumnInfo(name = "min_selections") var minSelections: Int? = null, // minimum number of selections for multi_select
    @ColumnInfo(name = "max_selections") var maxSelections: Int? = null, // maximum number of selections for multi_select
    @ColumnInfo(name = "skip_to_script") var skipToScript: String? = null, // JEXL expression - if true after validation, jump to target
    @ColumnInfo(name = "skip_to_target") var skipToTarget: String? = null, // short name of target question to jump to
    @ColumnInfo(name = "section_id") var sectionId: Int? = null // ID of the section this question belongs to
)

@Entity(tableName = "options")
data class Option(
    @PrimaryKey val id: Int,
    @ColumnInfo(name = "question_id") var questionId: Int,
    @ColumnInfo(name = "text") var text: String,
    @ColumnInfo(name = "audio_file_name") var audioFileName: String,
    @ColumnInfo(name = "option_question_index") var optionQuestionIndex: Int, // New field
    @ColumnInfo(name = "language") var language: String, // New field
    @ColumnInfo(name = "primary_language_text") var primaryLanguageText: String // New field
)

@Entity(tableName = "surveys")
data class Survey(
    @PrimaryKey val id: String = UUID.randomUUID().toString(),
    @ColumnInfo(name = "subject_id") var subjectId: String,
    @ColumnInfo(name = "start_datetime") var startDatetime: Long,
    @ColumnInfo(name = "language") var language: String,
    @ColumnInfo(name = "server_survey_id") var serverSurveyId: Long? = null, // Survey ID from management server
    @ColumnInfo(name = "referral_coupon_code") var referralCouponCode: String? = null,
    @ColumnInfo(name = "contact_phone") var contactPhone: String? = null,
    @ColumnInfo(name = "contact_email") var contactEmail: String? = null,
    @ColumnInfo(name = "contact_consent") var contactConsent: Boolean = false,
    @ColumnInfo(name = "sample_collected") var sampleCollected: Boolean? = null, // null=not reached, true=collected, false=refused
    @ColumnInfo(name = "payment_confirmed") var paymentConfirmed: Boolean? = null,
    @ColumnInfo(name = "payment_amount") var paymentAmount: Double? = null,
    @ColumnInfo(name = "payment_type") var paymentType: String? = null,
    @ColumnInfo(name = "payment_date") var paymentDate: Long? = null,
    @ColumnInfo(name = "eligibility_script") var eligibilityScript: String? = null, // JEXL script to determine eligibility
    @ColumnInfo(name = "hiv_rapid_test_result") var hivRapidTestResult: String? = null, // "positive", "negative", "indeterminate", "not_performed"
    @ColumnInfo(name = "consent_signature_path") var consentSignaturePath: String? = null, // Path to signature PNG file
    @ColumnInfo(name = "is_completed") var isCompleted: Boolean = false,
    @ColumnInfo(name = "payment_phone_number") var paymentPhoneNumber: String? = null, // Phone for payment audit
    // Marks rows inserted by facility restore (after a tablet reinstall) as
    // skeleton records. The tablet has the id + participant + chain info but
    // not the full questionnaire data, so callers that need real responses
    // should filter these out.
    @ColumnInfo(name = "is_stub", defaultValue = "0") var isStub: Boolean = false,
    // When this survey was successfully uploaded (device clock); null = not yet.
    // Used by the enrollment quota to add surveys the server count doesn't
    // include yet. Surveys completed before this column existed are backfilled
    // as uploaded (see SurveyDatabase.Migration72To73).
    @ColumnInfo(name = "uploaded_at") var uploadedAt: Long? = null
) {
    @Ignore
    var questions: MutableList<Question> = mutableListOf()

    @Ignore
    var answers: MutableList<Answer> = mutableListOf()

    fun populateFields(surveyDao: SurveyDao) {
        android.util.Log.d("Survey", "PopulateFields called for survey $id with language: $language")
        val questionCount = surveyDao.getQuestionCountByLanguage(this.language)
        android.util.Log.d("Survey", "Found $questionCount questions for language: $language")

        this.questions = surveyDao.getQuestionsByLanguage(this.language)
        android.util.Log.d("Survey", "Actually loaded ${this.questions.size} questions")

        val existingAnswers = surveyDao.getAnswersBySurveyId(this.id)
        val answersByQuestionId = existingAnswers.associateBy { it.questionId }

        // Build answers list aligned with questions, creating stubs only for missing answers
        this.answers = mutableListOf()
        for (question in questions) {
            val existingAnswer = answersByQuestionId[question.questionId]
            if (existingAnswer != null) {
                answers.add(existingAnswer)
            } else {
                // Create stub answer for this question
                answers.add(Answer(
                    surveyId = id,
                    questionId = question.questionId,
                    optionQuestionIndex = null,
                    answerLanguage = this.language,
                    answerPrimaryLanguageText = null,
                    isNumeric = question.questionType == "numeric",
                    isMultiSelect = question.questionType == "multi_select",
                    multiSelectIndices = if (question.questionType == "multi_select") "" else null
                ))
            }
        }
        android.util.Log.d("Survey", "Populated ${answers.size} answers (${existingAnswers.size} from DB, ${answers.size - existingAnswers.size} stubs)")
    }
}


@Entity(tableName = "answers")
data class Answer(
    @PrimaryKey val id: String = UUID.randomUUID().toString(),
    @ColumnInfo(name = "survey_id") var surveyId: String,
    @ColumnInfo(name = "question_id") var questionId: Int,
    @ColumnInfo(name = "option_question_index") var optionQuestionIndex: Int?,
    @ColumnInfo(name = "answer_language") var answerLanguage: String,
    @ColumnInfo(name = "answer_primary_language_text") var answerPrimaryLanguageText: String?,
    @ColumnInfo(name = "is_numeric") var isNumeric: Boolean = false,
    @ColumnInfo(name = "numeric_value") var numericValue: Double? = null,
    @ColumnInfo(name = "is_multi_select") var isMultiSelect: Boolean = false,
    @ColumnInfo(name = "multi_select_indices") var multiSelectIndices: String? = null // comma-separated indices
) {
    fun getValue(returnIndex: Boolean = true): Any? {
        if(isNumeric){
            return numericValue
        }
        if(isMultiSelect) {
            return multiSelectIndices // Returns comma-separated indices
        }
        if(optionQuestionIndex == null && answerPrimaryLanguageText != null){
            return answerPrimaryLanguageText
        }
        if(returnIndex) {
            return optionQuestionIndex
        }
        return answerPrimaryLanguageText
    }
    
    fun getSelectedIndices(): List<Int> {
        return multiSelectIndices?.split(",")?.mapNotNull { it.toIntOrNull() } ?: emptyList()
    }
    
    fun setSelectedIndices(indices: List<Int>) {
        multiSelectIndices = indices.joinToString(",")
    }
}

@Entity(tableName = "users")
data class User(
    @PrimaryKey
    val userName: String,
    val hashedPassword: String,
    val fullName: String,
    val role: String, // e.g., "SURVEY_STAFF", "ADMINISTRATOR"
    @ColumnInfo(name = "biometric_key_hash") val biometricKeyHash: String? = null,
    @ColumnInfo(name = "biometric_enabled") val biometricEnabled: Boolean = false,
    @ColumnInfo(name = "biometric_enrolled_date") val biometricEnrolledDate: Long? = null,
    @ColumnInfo(name = "last_biometric_auth") val lastBiometricAuth: Long? = null,
    @ColumnInfo(name = "session_timeout_minutes") val sessionTimeoutMinutes: Long = 180,
    @ColumnInfo(name = "last_login_time") val lastLoginTime: Long? = null,
    @ColumnInfo(name = "last_activity_time") val lastActivityTime: Long? = null,
    @ColumnInfo(name = "upload_server_url") val uploadServerUrl: String? = null,
    @ColumnInfo(name = "upload_api_key") val uploadApiKey: String? = null,
    @ColumnInfo(name = "fingerprint_template", typeAffinity = ColumnInfo.BLOB) val fingerprintTemplate: ByteArray? = null
)

@Entity(tableName = "survey_upload_state")
data class SurveyUploadState(
    @PrimaryKey
    val surveyId: String,
    @ColumnInfo(name = "upload_status") val uploadStatus: String, // PENDING, UPLOADING, COMPLETED, FAILED
    @ColumnInfo(name = "last_attempt_time") val lastAttemptTime: Long? = null,
    @ColumnInfo(name = "attempt_count") val attemptCount: Int = 0,
    @ColumnInfo(name = "error_message") val errorMessage: String? = null,
    @ColumnInfo(name = "created_time") val createdTime: Long = System.currentTimeMillis(),
    @ColumnInfo(name = "completed_time") val completedTime: Long? = null
)

@Entity(tableName = "recruitment_payment_upload_state")
data class RecruitmentPaymentUploadState(
    @PrimaryKey
    val paymentId: String,
    @ColumnInfo(name = "survey_id") val surveyId: String,
    @ColumnInfo(name = "subject_id") val subjectId: String,
    @ColumnInfo(name = "coupon_codes") val couponCodes: String, // comma-separated
    @ColumnInfo(name = "payment_amount") val paymentAmount: Double,
    @ColumnInfo(name = "payment_phone") val paymentPhone: String?,
    @ColumnInfo(name = "signature_hex") val signatureHex: String?,
    @ColumnInfo(name = "confirmation_method") val confirmationMethod: String, // "fingerprint" or "signature"
    @ColumnInfo(name = "upload_status") val uploadStatus: String, // PENDING, COMPLETED, FAILED
    @ColumnInfo(name = "last_attempt_time") val lastAttemptTime: Long? = null,
    @ColumnInfo(name = "attempt_count") val attemptCount: Int = 0,
    @ColumnInfo(name = "error_message") val errorMessage: String? = null,
    @ColumnInfo(name = "created_time") val createdTime: Long = System.currentTimeMillis()
)

@Entity(tableName = "coupons")
data class Coupon(
    @PrimaryKey
    val couponCode: String,
    @ColumnInfo(name = "issued_to_survey_id") val issuedToSurveyId: String? = null,
    @ColumnInfo(name = "issued_date") val issuedDate: Long? = null,
    @ColumnInfo(name = "used_by_survey_id") val usedBySurveyId: String? = null,
    @ColumnInfo(name = "used_date") val usedDate: Long? = null,
    @ColumnInfo(name = "status") val status: String = "UNUSED", // UNUSED, ISSUED, USED
    @ColumnInfo(name = "created_date") val createdDate: Long = System.currentTimeMillis(),
    @ColumnInfo(name = "recruitment_payment_date") val recruitmentPaymentDate: Long? = null, // When recruitment payment was made
    @ColumnInfo(name = "recruitment_payment_signature") val recruitmentPaymentSignature: String? = null // Hex PNG signature for non-fingerprint confirmation
)

@Entity(tableName = "facility_config")
data class FacilityConfig(
    @PrimaryKey
    val id: Int = 1, // Single row for facility configuration
    @ColumnInfo(name = "facility_id") val facilityId: Int? = null,
    @ColumnInfo(name = "facility_name") val facilityName: String? = null,
    @ColumnInfo(name = "allow_non_coupon_participants") val allowNonCouponParticipants: Boolean = true,
    @ColumnInfo(name = "coupons_to_issue") val couponsToIssue: Int = 3,
    @ColumnInfo(name = "seed_recruitment_active") val seedRecruitmentActive: Boolean = false,
    @ColumnInfo(name = "seed_contact_rate_days") val seedContactRateDays: Int = 7,
    @ColumnInfo(name = "seed_recruitment_window_min_days") val seedRecruitmentWindowMinDays: Int = 0,
    @ColumnInfo(name = "seed_recruitment_window_max_days") val seedRecruitmentWindowMaxDays: Int = 730,
    @ColumnInfo(name = "subject_payment_type") val subjectPaymentType: String = "None",
    @ColumnInfo(name = "participation_payment_amount") val participationPaymentAmount: Double = 0.0,
    @ColumnInfo(name = "recruitment_payment_amount") val recruitmentPaymentAmount: Double = 0.0,
    @ColumnInfo(name = "payment_currency") val paymentCurrency: String = "USD",
    @ColumnInfo(name = "payment_currency_symbol") val paymentCurrencySymbol: String = "$",
    // Optional enrollment quota; null = no limit. See util/EnrollmentQuota.
    @ColumnInfo(name = "enrollment_quota") val enrollmentQuota: Int? = null,
    // Facility-wide enrolled count reported by the server at the last config sync,
    // and when (device clock) it was received. null = never received.
    @ColumnInfo(name = "server_enrollment_count") val serverEnrollmentCount: Int? = null,
    @ColumnInfo(name = "server_enrollment_count_time") val serverEnrollmentCountTime: Long? = null,
    @ColumnInfo(name = "last_sync_time") val lastSyncTime: Long? = null,
    @ColumnInfo(name = "sync_status") val syncStatus: String = "PENDING"
)

@Entity(tableName = "seed_recruitment")
data class SeedRecruitment(
    @PrimaryKey(autoGenerate = true)
    val id: Int = 0,
    @ColumnInfo(name = "selected_subject_id") val selectedSubjectId: String,
    @ColumnInfo(name = "selected_date") val selectedDate: Long,
    @ColumnInfo(name = "contact_info") val contactInfo: String,
    @ColumnInfo(name = "contact_type") val contactType: String, // "phone" or "email"
    @ColumnInfo(name = "coupon_code") val couponCode: String,
    @ColumnInfo(name = "message_sent") val messageSent: Boolean = false,
    @ColumnInfo(name = "sent_date") val sentDate: Long? = null
)

@Entity(tableName = "subject_fingerprints")
data class SubjectFingerprint(
    @PrimaryKey(autoGenerate = true)
    val id: Int = 0,
    @ColumnInfo(name = "survey_id") val surveyId: String,
    @ColumnInfo(name = "fingerprint_template", typeAffinity = ColumnInfo.BLOB) val fingerprintTemplate: ByteArray,
    @ColumnInfo(name = "enrollment_date") val enrollmentDate: Long,
    @ColumnInfo(name = "facility_id") val facilityId: Int? = null
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false

        other as SubjectFingerprint

        if (id != other.id) return false
        if (surveyId != other.surveyId) return false
        if (!fingerprintTemplate.contentEquals(other.fingerprintTemplate)) return false
        if (enrollmentDate != other.enrollmentDate) return false
        if (facilityId != other.facilityId) return false

        return true
    }

    override fun hashCode(): Int {
        var result = id
        result = 31 * result + surveyId.hashCode()
        result = 31 * result + fingerprintTemplate.contentHashCode()
        result = 31 * result + enrollmentDate.hashCode()
        result = 31 * result + (facilityId ?: 0)
        return result
    }
}

enum class CouponStatus {
    UNUSED,
    ISSUED, 
    USED
}

enum class UploadStatus {
    PENDING,
    UPLOADING,
    COMPLETED,
    FAILED
}

// Global app server configuration
@Entity(tableName = "app_server_config")
data class AppServerConfig(
    @PrimaryKey val id: Int = 1, // Single row table
    @ColumnInfo(name = "server_url") val serverUrl: String,
    @ColumnInfo(name = "api_key") val apiKey: String,
    @ColumnInfo(name = "updated_at") val updatedAt: Long = System.currentTimeMillis()
)

// This is for backward compatibility with getAnyServerConfig query
data class ServerConfig(
    @ColumnInfo(name = "upload_server_url") val uploadServerUrl: String?,
    @ColumnInfo(name = "upload_api_key") val uploadApiKey: String?
)

@Dao
interface SurveyDao {

    @Query("SELECT * FROM questions WHERE question_language = :language ORDER BY question_id")
    fun getQuestionsByLanguage(language: String): MutableList<Question>

    @Query("SELECT * FROM answers WHERE survey_id = :surveyId ORDER BY question_id")
    fun getAnswersBySurveyId(surveyId: String): MutableList<Answer>

    @Query("SELECT * FROM questions")
    fun getAllQuestions(): List<Question>
    
    @Query("SELECT COUNT(*) FROM questions WHERE question_language = :language")
    fun getQuestionCountByLanguage(language: String): Int

    @Query("SELECT * FROM options WHERE question_id = :questionId")
    fun getOptionsForQuestion(questionId: Int): List<Option>

    @Insert
    fun insertQuestion(question: Question)

    @Insert
    fun insertOption(option: Option)

    @Insert
    fun insertSurvey(survey: Survey)

    // Used by facility restore: never overwrite a survey the user has already
    // started/completed locally.
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun insertSurveyIfAbsent(survey: Survey): Long

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertAnswer(answer: Answer)

    @Delete
    fun deleteSurvey(survey: Survey)

    @Delete
    fun deleteAnswer(answer: Answer)

    @Query("SELECT * FROM surveys WHERE id = :surveyId LIMIT 1")
    fun getSurveyById(surveyId: String): Survey?
    
    @Update
    fun updateSurvey(survey: Survey)
    
    @Query("SELECT * FROM surveys WHERE contact_phone IS NOT NULL OR contact_email IS NOT NULL")
    fun getAllSurveysWithContact(): List<Survey>
    
    @Query("SELECT DISTINCT question_language FROM questions ORDER BY question_language")
    fun getDistinctLanguages(): List<String>
    
    @Query("SELECT * FROM surveys WHERE referral_coupon_code = :couponCode ORDER BY start_datetime DESC LIMIT 1")
    fun getMostRecentSurveyByCoupon(couponCode: String?): Survey?
    
    @Query("SELECT * FROM surveys ORDER BY start_datetime DESC LIMIT 1")
    fun getMostRecentSurvey(): Survey?

    @Query("SELECT * FROM surveys ORDER BY start_datetime DESC")
    fun getAllSurveys(): List<Survey>

    @Query("SELECT COUNT(*) FROM surveys WHERE subject_id = :subjectId")
    fun countSurveysWithSubjectId(subjectId: String): Int

    // Enrolled = eligible completions (always paymentConfirmed, even with no
    // payment) plus restore stubs (uploaded surveys). Ineligible surveys are
    // completed but never paymentConfirmed. Used for the enrollment quota.
    @Query("SELECT COUNT(*) FROM surveys WHERE is_completed = 1 AND (payment_confirmed = 1 OR is_stub = 1)")
    fun countEnrolledSurveys(): Int

    // Enrolled surveys on this tablet that the server's count (received at
    // :serverCountTime) does not include yet: not uploaded, or uploaded after
    // that count was taken. Stubs came from the server, so they never count here.
    @Query("SELECT COUNT(*) FROM surveys WHERE is_completed = 1 AND payment_confirmed = 1 AND is_stub = 0 AND (uploaded_at IS NULL OR uploaded_at > :serverCountTime)")
    fun countEnrolledNotInServerCount(serverCountTime: Long): Int

    @Query("UPDATE surveys SET uploaded_at = :uploadedAt WHERE id = :surveyId")
    fun markSurveyUploaded(surveyId: String, uploadedAt: Long)

    @Query("DELETE FROM surveys WHERE is_completed = 0 AND start_datetime < :cutoffTime")
    fun deleteIncompleteSurveys(cutoffTime: Long): Int

    @Query("DELETE FROM answers WHERE survey_id IN (SELECT id FROM surveys WHERE is_completed = 0 AND start_datetime < :cutoffTime)")
    fun deleteIncompleteAnswers(cutoffTime: Long): Int

    @Query("SELECT EXISTS(SELECT 1 FROM coupons WHERE couponCode = :couponCode LIMIT 1)")
    fun isCouponCodeExists(couponCode: String): Boolean

    @Query("SELECT EXISTS(SELECT 1 FROM surveys WHERE subject_id = :subjectId LIMIT 1)")
    fun isSubjectIdExists(subjectId: String): Boolean

    @Query("SELECT * FROM surveys WHERE subject_id = :subjectId LIMIT 1")
    fun getSurveyBySubjectId(subjectId: String): Survey?

    @Query("""
        SELECT * FROM surveys
        WHERE subject_id = :subjectId AND is_completed = 1
        ORDER BY start_datetime DESC
        LIMIT 1
    """)
    fun getCompletedSurveyBySubjectId(subjectId: String): Survey?

    @Delete
    fun deleteQuestion(question: Question)

    @Delete
    fun deleteOption(option: Option)

    @Query("DELETE FROM options")
    fun deleteAllOptions()

    @Query("DELETE FROM questions")
    fun deleteAllQuestions()
}

fun saveSurvey(survey: Survey, surveyDao: SurveyDao) {
    surveyDao.insertSurvey(survey)
    survey.answers.forEach { answer ->
        surveyDao.insertAnswer(answer)
    }
}

fun deleteSurvey(survey: Survey, surveyDao: SurveyDao) {
    surveyDao.getAnswersBySurveyId(survey.id).forEach { answer ->
        surveyDao.deleteAnswer(answer)
    }
    surveyDao.deleteSurvey(survey)
}

@Dao
interface UserDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertUser(user: User)

    @Update
    fun updateUser(user: User)

    @Query("SELECT * FROM users WHERE userName = :userName LIMIT 1")
    fun getUserByUserName(userName: String): User?

    @Query("SELECT * FROM users")
    fun getAllUsers(): List<User>

    @Query("SELECT * FROM users WHERE role = :role")
    fun getUsersByRole(role: String): List<User>

    @Query("DELETE FROM users WHERE userName = :userName")
    fun deleteUser(userName: String)

    @Query("UPDATE users SET hashedPassword = :hashedPassword WHERE userName = :userName")
    fun updateUserPassword(userName: String, hashedPassword: String)

    @Query("UPDATE users SET fullName = :fullName WHERE userName = :userName")
    fun updateUserFullName(userName: String, fullName: String)

    @Query("UPDATE users SET role = :role WHERE userName = :userName")
    fun updateUserRole(userName: String, role: String)

    @Query("SELECT COUNT(*) FROM users WHERE role = 'ADMINISTRATOR'")
    fun getAdminCount(): Int

    @Query("UPDATE users SET biometric_key_hash = :keyHash, biometric_enabled = :enabled, biometric_enrolled_date = :enrolledDate WHERE userName = :userName")
    fun updateUserBiometric(userName: String, keyHash: String?, enabled: Boolean, enrolledDate: Long?)

    @Query("UPDATE users SET last_biometric_auth = :authTime WHERE userName = :userName")
    fun updateLastBiometricAuth(userName: String, authTime: Long)

    @Query("SELECT * FROM users WHERE userName = :userName AND biometric_enabled = 1 LIMIT 1")
    fun getUserForBiometricAuth(userName: String): User?

    @Query("SELECT * FROM users WHERE biometric_enabled = 1")
    fun getUsersWithBiometricEnabled(): List<User>

    @Query("UPDATE users SET last_login_time = :loginTime, last_activity_time = :activityTime WHERE userName = :userName")
    fun updateUserSessionTimes(userName: String, loginTime: Long, activityTime: Long)

    @Query("UPDATE users SET last_activity_time = :activityTime WHERE userName = :userName")
    fun updateUserActivity(userName: String, activityTime: Long)

    @Query("UPDATE users SET session_timeout_minutes = :timeoutMinutes WHERE userName = :userName")
    fun updateUserSessionTimeout(userName: String, timeoutMinutes: Long)

    @Query("UPDATE users SET upload_server_url = :serverUrl, upload_api_key = :apiKey WHERE userName = :userName")
    fun updateUserServerConfig(userName: String, serverUrl: String?, apiKey: String?)

    @Query("SELECT upload_server_url, upload_api_key FROM users WHERE userName = :userName AND role = 'ADMINISTRATOR' LIMIT 1")
    fun getAdminServerConfig(userName: String): ServerConfig?
    
    @Query("SELECT upload_server_url, upload_api_key FROM users WHERE upload_server_url IS NOT NULL AND upload_api_key IS NOT NULL AND role = 'ADMINISTRATOR' LIMIT 1")
    fun getAnyServerConfig(): ServerConfig?
}

@Dao
interface UploadStateDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertUploadState(uploadState: SurveyUploadState)

    @Query("SELECT * FROM survey_upload_state WHERE surveyId = :surveyId")
    fun getUploadState(surveyId: String): SurveyUploadState?

    @Query("SELECT * FROM survey_upload_state WHERE upload_status = :status ORDER BY created_time ASC")
    fun getUploadStatesByStatus(status: String): List<SurveyUploadState>

    @Query("SELECT * FROM survey_upload_state WHERE upload_status IN ('PENDING', 'FAILED') ORDER BY created_time ASC")
    fun getPendingUploads(): List<SurveyUploadState>

    @Query("SELECT * FROM survey_upload_state ORDER BY created_time DESC")
    fun getAllUploadStates(): List<SurveyUploadState>

    @Query("UPDATE survey_upload_state SET upload_status = :status, last_attempt_time = :attemptTime, attempt_count = :attemptCount, error_message = :errorMessage WHERE surveyId = :surveyId")
    fun updateUploadAttempt(surveyId: String, status: String, attemptTime: Long, attemptCount: Int, errorMessage: String?)

    @Query("UPDATE survey_upload_state SET upload_status = :status, completed_time = :completedTime WHERE surveyId = :surveyId")
    fun markUploadCompleted(surveyId: String, status: String, completedTime: Long)

    @Query("DELETE FROM survey_upload_state WHERE surveyId = :surveyId")
    fun deleteUploadState(surveyId: String)

    @Query("DELETE FROM survey_upload_state WHERE upload_status = 'COMPLETED' AND completed_time < :beforeTime")
    fun cleanupOldCompletedUploads(beforeTime: Long)
}

@Dao
interface RecruitmentPaymentUploadStateDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insert(state: RecruitmentPaymentUploadState)

    @Query("SELECT * FROM recruitment_payment_upload_state WHERE paymentId = :paymentId")
    fun getByPaymentId(paymentId: String): RecruitmentPaymentUploadState?

    @Query("SELECT * FROM recruitment_payment_upload_state WHERE upload_status IN ('PENDING', 'FAILED') ORDER BY created_time ASC")
    fun getPendingUploads(): List<RecruitmentPaymentUploadState>

    @Query("SELECT * FROM recruitment_payment_upload_state ORDER BY created_time DESC")
    fun getAllUploadStates(): List<RecruitmentPaymentUploadState>

    @Query("UPDATE recruitment_payment_upload_state SET upload_status = :status, last_attempt_time = :time, attempt_count = :count, error_message = :error WHERE paymentId = :paymentId")
    fun updateAttempt(paymentId: String, status: String, time: Long, count: Int, error: String?)

    @Query("UPDATE recruitment_payment_upload_state SET upload_status = 'COMPLETED' WHERE paymentId = :paymentId")
    fun markCompleted(paymentId: String)

    @Query("DELETE FROM recruitment_payment_upload_state WHERE paymentId = :paymentId")
    fun delete(paymentId: String)
}

@Dao
interface CouponDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertCoupon(coupon: Coupon)

    // Used by facility restore: skip codes that already exist locally rather
    // than overwriting state the tablet may have produced after restore.
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun insertCouponIfAbsent(coupon: Coupon): Long

    @Query("SELECT * FROM coupons WHERE couponCode = :code LIMIT 1")
    fun getCouponByCode(code: String): Coupon?

    @Query("SELECT * FROM coupons WHERE issued_to_survey_id = :surveyId")
    fun getCouponsIssuedToSurvey(surveyId: String): List<Coupon>

    @Query("SELECT * FROM coupons WHERE status = :status")
    fun getCouponsByStatus(status: String): List<Coupon>

    @Query("UPDATE coupons SET status = 'ISSUED', issued_to_survey_id = :surveyId, issued_date = :issuedDate WHERE couponCode = :code")
    fun markCouponIssued(code: String, surveyId: String, issuedDate: Long)

    @Query("UPDATE coupons SET status = 'USED', used_by_survey_id = :surveyId, used_date = :usedDate WHERE couponCode = :code")
    fun markCouponUsed(code: String, surveyId: String, usedDate: Long)

    @Query("UPDATE coupons SET status = 'ISSUED' WHERE issued_to_survey_id = :surveyId AND status = 'UNUSED'")
    fun markCouponsAsIssued(surveyId: String)

    @Query("SELECT COUNT(*) FROM coupons WHERE status = 'UNUSED'")
    fun getUnusedCouponCount(): Int

    @Query("DELETE FROM coupons WHERE couponCode = :code")
    fun deleteCoupon(code: String)

    // Recruitment payment methods
    @Query("UPDATE coupons SET recruitment_payment_date = :paymentDate, recruitment_payment_signature = :signature WHERE couponCode = :code")
    fun markRecruitmentPaymentMade(code: String, paymentDate: Long, signature: String?)

    @Query("SELECT * FROM coupons WHERE issued_to_survey_id = :surveyId AND status = 'USED' AND recruitment_payment_date IS NULL")
    fun getUnpaidUsedCoupons(surveyId: String): List<Coupon>

    @Query("SELECT * FROM coupons WHERE issued_to_survey_id = :surveyId AND status = 'USED'")
    fun getUsedCouponsForSurvey(surveyId: String): List<Coupon>
}

@Dao
interface SyncMetadataDao {
    @Query("SELECT * FROM sync_metadata WHERE id = 1 LIMIT 1")
    fun getSyncMetadata(): SyncMetadata?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertSyncMetadata(metadata: SyncMetadata)

    @Query("UPDATE sync_metadata SET sync_status = :status, last_error = :error WHERE id = 1")
    fun updateSyncStatus(status: String, error: String? = null)

    @Query("UPDATE sync_metadata SET last_sync_time = :time, sync_status = 'SUCCESS' WHERE id = 1")
    fun updateLastSyncSuccess(time: Long)

    @Query("UPDATE sync_metadata SET survey_checksum = :checksum WHERE id = 1")
    fun updateSurveyChecksum(checksum: String)
}

@Dao
interface SectionDao {
    @Query("SELECT * FROM sections ORDER BY section_index")
    fun getAllSections(): List<Section>

    @Query("SELECT * FROM sections WHERE id = :sectionId")
    fun getSectionById(sectionId: Int): Section?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertSection(section: Section)

    @Query("DELETE FROM sections")
    fun deleteAllSections()
}

@Dao
interface SurveyConfigDao {
    @Query("SELECT * FROM survey_config WHERE id = 1 LIMIT 1")
    fun getSurveyConfig(): SurveyConfig?
    
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertSurveyConfig(config: SurveyConfig)
    
    @Query("UPDATE survey_config SET fingerprint_enabled = :enabled, re_enrollment_days = :days WHERE id = 1")
    fun updateFingerprintSettings(enabled: Boolean, days: Int)
    
    @Query("UPDATE survey_config SET last_sync_time = :time WHERE id = 1")
    fun updateLastSyncTime(time: Long)
}

@Dao
interface FacilityConfigDao {
    @Query("SELECT * FROM facility_config WHERE id = 1 LIMIT 1")
    fun getFacilityConfig(): FacilityConfig?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertFacilityConfig(config: FacilityConfig)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertOrUpdate(config: FacilityConfig)

    @Query("UPDATE facility_config SET allow_non_coupon_participants = :allow, coupons_to_issue = :count WHERE id = 1")
    fun updateFacilitySettings(allow: Boolean, count: Int)

    @Query("UPDATE facility_config SET facility_id = :facilityId, facility_name = :facilityName WHERE id = 1")
    fun updateFacilityInfo(facilityId: Int, facilityName: String)

    @Query("UPDATE facility_config SET last_sync_time = :time, sync_status = 'SUCCESS' WHERE id = 1")
    fun updateLastSyncSuccess(time: Long)

    @Query("DELETE FROM facility_config")
    fun deleteAll()
}

@Dao
interface SeedRecruitmentDao {
    @Insert
    fun insertRecruitment(recruitment: SeedRecruitment): Long
    
    @Update
    fun updateRecruitment(recruitment: SeedRecruitment)
    
    @Query("SELECT * FROM seed_recruitment WHERE message_sent = 0 AND selected_date > :minDate ORDER BY selected_date DESC LIMIT 1")
    fun getActiveRecruitment(minDate: Long): SeedRecruitment?
    
    @Query("SELECT * FROM seed_recruitment WHERE sent_date > :minDate")
    fun getRecentlySentRecruitments(minDate: Long): List<SeedRecruitment>
    
    @Query("SELECT * FROM surveys WHERE contact_consent = 1 AND (contact_phone IS NOT NULL OR contact_email IS NOT NULL) AND start_datetime BETWEEN :minDate AND :maxDate AND id NOT IN (SELECT selected_subject_id FROM seed_recruitment WHERE sent_date > :recentContactDate) ORDER BY RANDOM() LIMIT 1")
    fun getRandomEligibleSubject(minDate: Long, maxDate: Long, recentContactDate: Long): Survey?
    
    @Query("UPDATE seed_recruitment SET message_sent = 1, sent_date = :sentDate WHERE id = :id")
    fun markMessageSent(id: Int, sentDate: Long)
}

@Dao
interface SubjectFingerprintDao {
    @Insert
    fun insertFingerprint(fingerprint: SubjectFingerprint): Long

    @Query("SELECT * FROM subject_fingerprints WHERE enrollment_date > :minDate ORDER BY enrollment_date DESC")
    fun getRecentFingerprints(minDate: Long): List<SubjectFingerprint>

    @Query("""
        SELECT sf.* FROM subject_fingerprints sf
        INNER JOIN surveys s ON sf.survey_id = s.id
        WHERE sf.enrollment_date >= :minDate
        AND s.is_completed = 1
        ORDER BY sf.enrollment_date DESC
    """)
    fun getRecentCompletedFingerprints(minDate: Long): List<SubjectFingerprint>

    @Query("SELECT * FROM subject_fingerprints WHERE survey_id = :surveyId LIMIT 1")
    fun getFingerprintBySurveyId(surveyId: String): SubjectFingerprint?

    @Query("SELECT COUNT(*) FROM subject_fingerprints WHERE enrollment_date > :minDate")
    fun countRecentFingerprints(minDate: Long): Int

    @Query("DELETE FROM subject_fingerprints WHERE enrollment_date < :beforeDate")
    fun deleteOldFingerprints(beforeDate: Long)
}

@Dao
interface SystemMessageDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertSystemMessage(message: SystemMessage)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertSystemMessages(messages: List<SystemMessage>)

    @Query("SELECT * FROM system_messages WHERE messageKey = :key AND language = :language LIMIT 1")
    fun getSystemMessage(key: String, language: String): SystemMessage?

    @Query("SELECT * FROM system_messages WHERE messageKey = :key LIMIT 1")
    fun getSystemMessageAnyLanguage(key: String): SystemMessage?

    @Query("SELECT * FROM system_messages WHERE messageKey = :key")
    fun getAllMessagesForKey(key: String): List<SystemMessage>

    @Query("DELETE FROM system_messages")
    fun deleteAllSystemMessages()
}

@Dao
interface AppServerConfigDao {
    @Query("SELECT * FROM app_server_config WHERE id = 1 LIMIT 1")
    fun getServerConfig(): AppServerConfig?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun setServerConfig(config: AppServerConfig)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertOrUpdate(config: AppServerConfig)

    @Query("DELETE FROM app_server_config")
    fun clearServerConfig()

    @Query("SELECT EXISTS(SELECT 1 FROM app_server_config WHERE id = 1)")
    fun hasServerConfig(): Boolean
}

@Database(entities = [Section::class, Question::class, Option::class, Survey::class, Answer::class, User::class, SurveyUploadState::class, RecruitmentPaymentUploadState::class, SyncMetadata::class, SurveyConfig::class, SystemMessage::class, Coupon::class, FacilityConfig::class, SeedRecruitment::class, SubjectFingerprint::class, AppServerConfig::class, TestConfiguration::class, TestResult::class, LabTestConfiguration::class], version = 73, autoMigrations = [
    AutoMigration(from = 52, to = 53),
    AutoMigration(from = 65, to = 66),
    AutoMigration(from = 66, to = 67),
    AutoMigration(from = 67, to = 68),
    AutoMigration(from = 68, to = 69),
    AutoMigration(from = 69, to = 70),
    AutoMigration(from = 70, to = 71),
    AutoMigration(from = 71, to = 72),
    AutoMigration(from = 72, to = 73, spec = SurveyDatabase.Migration72To73::class)
])
abstract class SurveyDatabase : RoomDatabase() {
    /**
     * Adds surveys.uploaded_at (plus the facility_config server count columns).
     * Existing completed surveys are marked as already uploaded: the auto-upload
     * worker has normally sent them long ago, and surveys left over from other
     * servers/facilities must not inflate the enrollment quota count. A genuinely
     * pending legacy survey is just missing from the count until the next config
     * sync after it uploads.
     */
    class Migration72To73 : androidx.room.migration.AutoMigrationSpec {
        override fun onPostMigrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
            db.execSQL("UPDATE surveys SET uploaded_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE is_completed = 1")
        }
    }

    abstract fun surveyDao(): SurveyDao
    abstract fun userDao(): UserDao
    abstract fun uploadStateDao(): UploadStateDao
    abstract fun recruitmentPaymentUploadStateDao(): RecruitmentPaymentUploadStateDao
    abstract fun syncMetadataDao(): SyncMetadataDao
    abstract fun sectionDao(): SectionDao
    abstract fun surveyConfigDao(): SurveyConfigDao
    abstract fun couponDao(): CouponDao
    abstract fun facilityConfigDao(): FacilityConfigDao
    abstract fun seedRecruitmentDao(): SeedRecruitmentDao
    abstract fun subjectFingerprintDao(): SubjectFingerprintDao
    abstract fun systemMessageDao(): SystemMessageDao
    abstract fun appServerConfigDao(): AppServerConfigDao
    abstract fun testConfigurationDao(): TestConfigurationDao
    abstract fun testResultDao(): TestResultDao
    abstract fun labTestConfigurationDao(): LabTestConfigurationDao
    companion object {
        private var instance: SurveyDatabase? = null

        fun getInstance(context: android.content.Context): SurveyDatabase {
            return instance ?: synchronized(this) {
                instance ?: buildDatabase(context).also { instance = it }
            }
        }
        
        private fun buildDatabase(context: android.content.Context): SurveyDatabase {
            // Get or create the encryption key
            val passphrase = DatabaseKeyManager.getDatabasePassphrase(context)
            val factory = SupportFactory(passphrase)
            
            return androidx.room.Room.databaseBuilder(
                context.applicationContext,
                SurveyDatabase::class.java,
                "survey_database_encrypted"
            )
                .openHelperFactory(factory)
                .fallbackToDestructiveMigration()
                .allowMainThreadQueries()
                .build()
        }
    }
}
