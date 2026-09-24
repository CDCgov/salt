package com.dev.salt.viewmodel
import com.dev.salt.logging.AppLogger as Log
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.dev.salt.data.Question
import com.dev.salt.data.Option
import com.dev.salt.data.SurveyDatabase
import com.dev.salt.data.Survey
import com.dev.salt.data.Answer
import com.dev.salt.data.saveSurvey
import com.dev.salt.evaluateJexlScript
import com.dev.salt.upload.SurveyUploadManager
import com.dev.salt.upload.SurveyUploadWorkManager
import com.dev.salt.upload.UploadResult
import com.dev.salt.ui.JexlDebugRequest
import com.dev.salt.debug.DeveloperSettingsManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import android.content.Context
import com.dev.salt.util.CouponGenerator

// Navigation events for the survey
sealed class SurveyNavigationEvent {
    object NavigateToRapidTests : SurveyNavigationEvent()
    object NavigateToHivTest : SurveyNavigationEvent()  // For backward compatibility
}

// Survey completion state for proper async coordination
sealed class SurveyCompletionState {
    object NotCompleted : SurveyCompletionState()
    object Saving : SurveyCompletionState()
    data class Completed(val coupons: List<String>) : SurveyCompletionState()
    data class Failed(val error: String) : SurveyCompletionState()
}

class SurveyViewModel(
    private val database: SurveyDatabase,
    private val context: Context? = null,
    private val referralCouponCode: String? = null,
    private val surveyId: String? = null
) : ViewModel() {
    private val _currentQuestion = MutableStateFlow<Triple<Question, List<Option>, Answer?>?>(null)
    val currentQuestion: StateFlow<Triple<Question, List<Option>, Answer?>?> = _currentQuestion

    // Navigation event flow
    private val _navigationEvent = MutableSharedFlow<SurveyNavigationEvent>()
    val navigationEvent: SharedFlow<SurveyNavigationEvent> = _navigationEvent

    // Track if we've already triggered navigation to rapid tests
    private var hasNavigatedToRapidTests = false
    private var hasNavigatedToHivTest = false

    private val _hasPreviousQuestion = mutableStateOf(false)
    val hasPreviousQuestion: State<Boolean> = _hasPreviousQuestion
    
    private val _generatedCoupons = MutableStateFlow<List<String>>(emptyList())
    val generatedCoupons: StateFlow<List<String>> = _generatedCoupons

    // Survey completion state for proper async coordination with SurveyScreen
    private val _surveyCompletionState = MutableStateFlow<SurveyCompletionState>(SurveyCompletionState.NotCompleted)
    val surveyCompletionState: StateFlow<SurveyCompletionState> = _surveyCompletionState

    private val couponGenerator = CouponGenerator(database.couponDao(), database.surveyDao())
    //public var currentQuestion: Pair<Question, List<Option>>? = null//StateFlow<Pair<Question, List<Option>>?> = _currentQuestion
    public var survey : Survey? = null
    public var questions: List<Question> = emptyList()
    //public var answers: MutableList<String?> = MutableList<String?>(0, { null })
    public var currentQuestionIndex = -1

    // Section tracking
    private var sections: List<com.dev.salt.data.Section> = emptyList()
    private var currentSection: com.dev.salt.data.Section? = null

    // Question navigation history - tracks the path user took through questions
    // This allows proper back navigation that respects skip-to jumps
    private val questionHistory = mutableListOf<Int>()

    // Eligibility check flow state
    private val _needsEligibilityCheck = MutableStateFlow(false)
    val needsEligibilityCheck: StateFlow<Boolean> = _needsEligibilityCheck

    private val _isEligible = MutableStateFlow<Boolean?>(null)
    val isEligible: StateFlow<Boolean?> = _isEligible

    // Track if we need to show HIV test after eligibility
    private val _needsHivTestAfterEligibility = MutableStateFlow(false)
    val needsHivTestAfterEligibility: StateFlow<Boolean> = _needsHivTestAfterEligibility

    // JEXL Debug request for showing debug dialog
    private val _jexlDebugRequest = MutableStateFlow<JexlDebugRequest?>(null)
    val jexlDebugRequest: StateFlow<JexlDebugRequest?> = _jexlDebugRequest

    // Pending eligibility debug info - Triple of (script, context, result)
    // This is used to show the debug dialog after eligibility check, before proceeding
    private val _pendingEligibilityDebug = MutableStateFlow<Triple<String, Map<String, Any?>, Boolean>?>(null)
    val pendingEligibilityDebug: StateFlow<Triple<String, Map<String, Any?>, Boolean>?> = _pendingEligibilityDebug

    // Flag to skip eligibility debug on re-entry (after dialog is dismissed)
    private var skipEligibilityDebug = false

    /**
     * Check if JEXL debug mode is enabled.
     * Returns false if context is not available.
     */
    private fun isJexlDebugEnabled(): Boolean {
        val enabled = context?.let { DeveloperSettingsManager.isJexlDebugEnabled(it) } ?: false
        Log.d("SurveyViewModel", "isJexlDebugEnabled: context=${context != null}, enabled=$enabled")
        return enabled
    }

    /**
     * Show a JEXL debug dialog and wait for user to continue.
     * The onContinue callback will be invoked when the user presses Continue.
     */
    fun showJexlDebugDialog(statement: String, jexlContext: Map<String, Any?>, scriptType: String, onContinue: () -> Unit) {
        _jexlDebugRequest.value = JexlDebugRequest(
            statement = statement,
            context = jexlContext,
            scriptType = scriptType,
            onContinue = {
                _jexlDebugRequest.value = null
                onContinue()
            }
        )
    }

    /**
     * Clear the JEXL debug dialog (called when user continues).
     */
    fun clearJexlDebugRequest() {
        _jexlDebugRequest.value = null
    }

    /**
     * Show the pending eligibility debug dialog.
     * Called from UI when it's ready to display the dialog.
     * After dialog is dismissed, re-runs eligibility check to continue with navigation.
     */
    fun showPendingEligibilityDebug() {
        val pending = _pendingEligibilityDebug.value ?: return
        val (script, context, result) = pending
        _jexlDebugRequest.value = JexlDebugRequest(
            statement = script,
            context = context,
            scriptType = "Eligibility (result: $result)",
            onContinue = {
                _jexlDebugRequest.value = null
                _pendingEligibilityDebug.value = null
                // Set flag to skip debug on re-entry
                skipEligibilityDebug = true
                // Re-run eligibility check to continue with consent/navigation
                Log.d("SurveyViewModel", "Debug dialog dismissed - re-running eligibility for navigation (skip debug)")
                checkEligibility()
            }
        )
    }

    /**
     * Clear the pending eligibility debug (if user dismisses without showing).
     */
    fun clearPendingEligibilityDebug() {
        _pendingEligibilityDebug.value = null
    }

    /**
     * Get the current question's preScript (skip logic) if any.
     */
    fun getCurrentPreScript(): String? {
        return _currentQuestion?.value?.first?.preScript?.takeIf { it.isNotBlank() }
    }

    /**
     * Get the current question's validationScript if any.
     */
    fun getCurrentValidationScript(): String? {
        return _currentQuestion?.value?.first?.validationScript?.takeIf { it.isNotBlank() }
    }

    /**
     * Get the current question's skipToScript if any.
     */
    fun getCurrentSkipToScript(): String? {
        val q = _currentQuestion?.value?.first ?: return null
        val script = q.skipToScript?.takeIf { it.isNotBlank() } ?: return null
        val target = q.skipToTarget?.takeIf { it.isNotBlank() } ?: return null
        return script
    }

    /**
     * Get the eligibility script if any.
     */
    fun getEligibilityScript(): String? {
        return survey?.eligibilityScript?.takeIf { it.isNotBlank() }
    }

    // Track if HIV test has been completed (deprecated - kept for backward compatibility)
    private val _hivTestCompleted = MutableStateFlow(false)
    val hivTestCompleted: StateFlow<Boolean> = _hivTestCompleted

    // New: Track if rapid tests are needed after eligibility
    private val _needsRapidTestsAfterEligibility = MutableStateFlow(false)
    val needsRapidTestsAfterEligibility: StateFlow<Boolean> = _needsRapidTestsAfterEligibility

    // Track if rapid tests have been completed
    private val _rapidTestsCompleted = MutableStateFlow(false)
    val rapidTestsCompleted: StateFlow<Boolean> = _rapidTestsCompleted

    // Track if consent is needed after eligibility (staff screening mode)
    private val _needsConsentAfterEligibility = MutableStateFlow(false)
    val needsConsentAfterEligibility: StateFlow<Boolean> = _needsConsentAfterEligibility

    fun clearConsentNeeded() {
        _needsConsentAfterEligibility.value = false
    }

    init {
        viewModelScope.launch {
            Log.d("SurveyViewModel", "Init called with surveyId=$surveyId, referralCouponCode=$referralCouponCode")
            loadQuestions()
            
            // Load existing survey if surveyId is provided, otherwise create new
            survey = if (surveyId != null) {
                val loadedSurvey = database.surveyDao().getSurveyById(surveyId)
                Log.d("SurveyViewModel", "Loaded existing survey: id=${loadedSurvey?.id}, language=${loadedSurvey?.language}")
                loadedSurvey ?: makeNewSurvey("en")
            } else {
                Log.d("SurveyViewModel", "Creating new survey")
                makeNewSurvey("en")
            }
            
            // NOTE: Coupon marking moved to SubjectPaymentScreen (after payment confirmed)
            // and EligibilityCheckScreen (when participant is ineligible).
            // Coupons should only be consumed when:
            // 1. Payment is confirmed, OR
            // 2. Participant is determined ineligible
            // NOT when the survey starts (to handle app closures mid-survey)

            loadSurvey(survey!!)
            loadNextQuestion()
        }
    }

    public fun getTheCurrentQuestionIndex() : Int {
        return currentQuestionIndex
    }

    private suspend fun makeNewSurvey(language: String): Survey {
        // Use coupon code as subject ID if participant has one, otherwise generate walk-in ID
        val couponGenerator = CouponGenerator(database.couponDao(), database.surveyDao())
        val subjectId = if (!referralCouponCode.isNullOrEmpty()) {
            // Participant has a coupon - use it as their subject ID
            referralCouponCode
        } else {
            // Walk-in participant - generate unique ID with "W" prefix to avoid collisions
            couponGenerator.generateUniqueWalkInSubjectId()
        }

        // Load eligibility script from SurveyConfig
        val eligibilityScript = database.surveyConfigDao().getSurveyConfig()?.eligibilityScript
        Log.d("SurveyViewModel", "Loaded eligibility script from SurveyConfig: $eligibilityScript")

        // Get server survey ID from sections table
        val serverSurveyId = database.sectionDao().getAllSections().firstOrNull()?.surveyId?.toLong()
        Log.d("SurveyViewModel", "Server survey ID from sections: $serverSurveyId")

        val survey: Survey = Survey(
            language = language,
            subjectId = subjectId,
            startDatetime = System.currentTimeMillis(),
            serverSurveyId = serverSurveyId,
            referralCouponCode = referralCouponCode,
            eligibilityScript = eligibilityScript
        )

        Log.d("SurveyViewModel", "Created survey with subjectId=$subjectId, serverSurveyId=$serverSurveyId, referralCoupon=$referralCouponCode, eligibilityScript=$eligibilityScript")
        return survey
    }

    private fun loadSurvey(surv: Survey){
        survey = surv

        // Load eligibility script from SurveyConfig if not already set
        if (survey?.eligibilityScript.isNullOrEmpty()) {
            val script = database.surveyConfigDao().getSurveyConfig()?.eligibilityScript
            survey?.eligibilityScript = script
            Log.d("SurveyViewModel", "Loaded eligibility script from SurveyConfig in loadSurvey: $script")
        }

        survey?.populateFields(database.surveyDao())
        questions = survey?.questions ?: emptyList()
        Log.d("SurveyViewModel", "Loaded survey with language: ${survey?.language}")
        Log.d("SurveyViewModel", "Number of questions loaded: ${questions.size}")

        // Also check what languages have questions
        val allLanguages = database.surveyDao().getDistinctLanguages()
        Log.d("SurveyViewModel", "Available languages in DB: $allLanguages")

        questions.forEach { q ->
            Log.d("SurveyViewModel", "Question: id=${q.id}, questionId=${q.questionId}, language=${q.questionLanguage}, text=${q.statement.take(50)}")
        }

        // Load sections
        viewModelScope.launch {
            try {
                sections = database.sectionDao().getAllSections()
                Log.d("SurveyViewModel", "Loaded ${sections.size} sections")

                // Determine initial section
                if (sections.isNotEmpty()) {
                    currentSection = sections.firstOrNull { it.sectionType == "eligibility" }
                        ?: sections.firstOrNull()
                    Log.d("SurveyViewModel", "Starting with section: ${currentSection?.name} (${currentSection?.sectionType})")
                }
            } catch (e: Exception) {
                Log.e("SurveyViewModel", "Error loading sections", e)
            }
        }
    }

    private fun loadQuestions() {
        questions = database.surveyDao().getAllQuestions()
    }

    // Save answer to database incrementally (survives Activity/ViewModel recreation)
    private fun saveAnswerToDatabase(answer: Answer) {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                database.surveyDao().insertAnswer(answer)
            } catch (e: Exception) {
                Log.e("SurveyViewModel", "Failed to save answer: ${answer.questionId}", e)
            }
        }
    }

    public fun updateCurrentQuestion() {
        if(survey == null){
            return
        }
        // Use question history to determine if there's a previous question
        // This accounts for skip-to jumps properly
        var canGoBack = questionHistory.isNotEmpty() || currentQuestionIndex > 0

        // Disable Previous button on the first question of the main (non-eligibility) section
        // to prevent navigating back to eligibility questions after consent
        if (canGoBack && currentQuestionIndex < questions.size) {
            val currentQ = questions[currentQuestionIndex]
            val currentQSection = sections.firstOrNull { it.id == currentQ.sectionId }

            // If current question is NOT in eligibility section
            if (currentQSection != null && currentQSection.sectionType != "eligibility") {
                // Check if previous question would be in eligibility section
                val prevIndex = if (questionHistory.isNotEmpty()) {
                    questionHistory.last()
                } else {
                    currentQuestionIndex - 1
                }
                if (prevIndex >= 0 && prevIndex < questions.size) {
                    val prevQ = questions[prevIndex]
                    val prevQSection = sections.firstOrNull { it.id == prevQ.sectionId }
                    // If previous question is in eligibility section, disable back navigation
                    if (prevQSection?.sectionType == "eligibility") {
                        canGoBack = false
                    }
                }
            }
        }
        _hasPreviousQuestion.value = canGoBack

        if (currentQuestionIndex < questions.size) {
            val question = questions[currentQuestionIndex]
            val options = database.surveyDao().getOptionsForQuestion(question.id)

            // Check if we've moved to a new section
            val navToRapidTests = checkSectionTransition(question)

            if(!navToRapidTests)
                _currentQuestion.value = Triple(question, options, survey!!.answers[currentQuestionIndex])
            //else
            //    currentQuestionIndex--
            //currentQuestion = Pair(question, options)
        } else {
            _currentQuestion.value = null
            //currentQuestion = null // Survey completed

            Log.i("SurveyViewModel", "Survey completed! Index: $currentQuestionIndex, Questions size: ${questions.size}")

            // Survey is completed - save and trigger upload
            survey?.let { completedSurvey ->
                viewModelScope.launch {
                    try {
                        // Signal that we're saving the survey
                        _surveyCompletionState.value = SurveyCompletionState.Saving

                        Log.i("SurveyViewModel", "Processing completed survey ${completedSurvey.id}")

                        // Answers are saved incrementally as user answers each question
                        // No need to re-save here (and doing so could overwrite valid answers
                        // with stale in-memory data if ViewModel was recreated mid-survey)

                        // Check if coupons have already been generated for this survey
                        val existingCoupons = database.couponDao().getCouponsIssuedToSurvey(completedSurvey.id)

                        val coupons: List<String> = if (existingCoupons.isEmpty()) {
                            // Generate coupons for completed survey
                            try {
                                // Get the number of coupons to issue from facility config
                                val facilityConfig = database.facilityConfigDao().getFacilityConfig()
                                val couponsToIssue = facilityConfig?.couponsToIssue ?: 3

                                Log.i("SurveyViewModel", "Generating $couponsToIssue coupons for survey ${completedSurvey.id}")
                                val generatedCoupons = couponGenerator.issueCouponsForSurvey(completedSurvey.id, couponsToIssue)
                                Log.i("SurveyViewModel", "Generated ${generatedCoupons.size} coupons for survey ${completedSurvey.id}: $generatedCoupons")
                                generatedCoupons
                            } catch (e: Exception) {
                                Log.e("SurveyViewModel", "Failed to generate coupons for survey ${completedSurvey.id}", e)
                                // Still return empty list so navigation can proceed
                                emptyList()
                            }
                        } else {
                            Log.i("SurveyViewModel", "Found ${existingCoupons.size} existing coupons for survey ${completedSurvey.id}")
                            Log.i("SurveyViewModel", "Using existing coupons: ${existingCoupons.map { it.couponCode }}")
                            existingCoupons.map { it.couponCode }
                        }

                        // Update both the legacy generatedCoupons flow and the new completion state
                        _generatedCoupons.value = coupons
                        _surveyCompletionState.value = SurveyCompletionState.Completed(coupons)

                        // Upload is now triggered from StaffValidationScreen after all steps are complete
                        // This ensures sample collection status is recorded before upload
                        Log.i("SurveyViewModel", "Survey ready for upload: ${completedSurvey.id} (upload will happen after staff validation)")
                    } catch (e: Exception) {
                        Log.e("SurveyViewModel", "Error completing survey", e)
                        _surveyCompletionState.value = SurveyCompletionState.Failed(e.message ?: "Unknown error")
                    }
                }
            }
        }
    }

    fun evaluateCurrentQuestionPreScript(): String{
        val script = _currentQuestion?.value?.first?.preScript
        if(script.isNullOrBlank()) {
            return "continue"
        }
        val context = buildJexlContext()
        var result = "continue" // Default action if no script or evaluation fails
        try {
            val ret = evaluateJexlScript(script, context)
            if(ret == true) {
                result = "skip"
            } else if(ret == null || ret == false){
                result = "continue"
            } else{
                result = ret.toString()
            }
            Log.d("JEXLResult", "Result of preScript: $result")

            // Show debug dialog if enabled
            if (isJexlDebugEnabled()) {
                _jexlDebugRequest.value = JexlDebugRequest(
                    statement = script,
                    context = context,
                    scriptType = "PreScript (Skip Logic)",
                    onContinue = { _jexlDebugRequest.value = null }
                )
            }
        } catch (e: Exception) {
            Log.e("JEXLError", "Error evaluating preScript: ${e.message}")
            result ="continue" // Default action on error
        }
        return result
    }

    fun evaluateCurrentQuestionValidationScript(): Boolean{
        val script = _currentQuestion?.value?.first?.validationScript
        if(script.isNullOrBlank()) {
            return true
        }
        val context = buildJexlContextWithValue()
        var result = true // Default action if no script or evaluation fails
        try {
            val ret = evaluateJexlScript(script, context)
            if(ret == null || ret == false) {
                result = false
            } else{
                result = true
            }
            Log.d("JEXLResult", "Result of validationScript: $result")

            // Show debug dialog if enabled
            if (isJexlDebugEnabled()) {
                _jexlDebugRequest.value = JexlDebugRequest(
                    statement = script,
                    context = context,
                    scriptType = "Validation",
                    onContinue = { _jexlDebugRequest.value = null }
                )
            }
        } catch (e: Exception) {
            Log.e("JEXLError", "Error evaluating validationScript: ${e.message}")
            result = true // Default action on error
        }
        return result
    }

    // Evaluate skip-to logic for current question
    private fun evaluateSkipToLogic(): String? {
        val currentQ = _currentQuestion?.value?.first ?: return null
        val skipToScript = currentQ.skipToScript
        val skipToTarget = currentQ.skipToTarget

        // Both script and target must be present
        if (skipToScript.isNullOrBlank() || skipToTarget.isNullOrBlank()) {
            return null
        }

        val context = buildJexlContextWithValue()
        return try {
            val result = evaluateJexlScript(skipToScript, context)
            Log.d("SurveyViewModel", "Skip-to script evaluation: $result")

            // Show debug dialog if enabled
            if (isJexlDebugEnabled()) {
                _jexlDebugRequest.value = JexlDebugRequest(
                    statement = skipToScript,
                    context = context,
                    scriptType = "Skip-To (target: $skipToTarget)",
                    onContinue = { _jexlDebugRequest.value = null }
                )
            }

            if (result == true) {
                skipToTarget // Return the target question short name
            } else {
                null
            }
        } catch (e: Exception) {
            Log.e("SurveyViewModel", "Error evaluating skip-to script: ${e.message}")
            null // Don't skip on error
        }
    }

    public fun jumpToQuestion(targetShortName: String){
        val questions = survey?.questions ?: return

        // Find the target question index
        val targetIndex = questions.indexOfFirst { it.questionShortName == targetShortName }
        jumpToQuestion(targetIndex)
    }

    // Jump to a specific question by short name
    public fun jumpToQuestion(targetIndex: Int) {
        val questions = survey?.questions ?: return

        if (targetIndex >= 0) {
            Log.d("SurveyViewModel", "Jumping from index $currentQuestionIndex to $targetIndex")
            currentQuestionIndex = targetIndex
            updateCurrentQuestion()

            // If the target (or a hidden run after it) should be skipped,
            // settle on the first visible question — a hidden question's
            // skip_to/validation must not run.
            advancePastHiddenQuestions()
        } else {
            Log.w("SurveyViewModel", "Skip-to target not found: $targetIndex")
            // If target not found, just proceed normally
            currentQuestionIndex++
            updateCurrentQuestion()
        }
    }

    // Internal jump function that doesn't add to history (used when called from loadNextQuestion which already added to history)
    private fun jumpToQuestionWithoutHistory(targetShortName: String) {
        val questions = survey?.questions ?: return

        // Find the target question index
        val targetIndex = questions.indexOfFirst { it.questionShortName == targetShortName }

        if (targetIndex >= 0) {
            Log.d("SurveyViewModel", "Jumping (no history) from index $currentQuestionIndex to $targetIndex (target: $targetShortName)")
            currentQuestionIndex = targetIndex
            updateCurrentQuestion()

            // If the target (or a hidden run after it) should be skipped,
            // settle on the first visible question — a hidden question's
            // skip_to/validation must not run.
            advancePastHiddenQuestions()
        } else {
            Log.w("SurveyViewModel", "Skip-to target not found: $targetShortName")
            // If target not found, just proceed normally
            currentQuestionIndex++
            updateCurrentQuestion()
        }
    }

    // Helper function to build the JEXL context - public for debug dialog use
    fun buildJexlContext(): Map<String, Any?> {
        val context = mutableMapOf<String, Any?>()
        val ans = survey!!.answers
        val qus = survey!!.questions
        for(i in 0 until ans.size){
            // multi_select answers enter JEXL as a List<Int> of selected
            // option indices, so survey logic can use contains() / =~ rather
            // than parsing a comma-separated string.
            val av : Any? = if (ans[i].isMultiSelect) ans[i].getSelectedIndices()
                            else ans[i].getValue()
            context[qus[i].questionShortName] = av
            Log.d("JEXLContext", "Adding to context: ${qus[i].questionShortName} = $av")
        }
        // You can add other global variables to the context if needed
        // context["userAge"] = 25 // Example
        Log.d("SurveyViewModel", "JEXL Context built: $context")
        return context
    }

    // JEXL context for scripts that run AFTER the current question is
    // answered (validation_script, skip_to_script): the standard context plus
    // `value` bound to the current question's own answer. `value` is a
    // reserved short_name (enforced server-side), so it never collides.
    private fun buildJexlContextWithValue(): Map<String, Any?> {
        val context = buildJexlContext().toMutableMap()
        val currentShortName = _currentQuestion?.value?.first?.questionShortName
        if (currentShortName != null) {
            context["value"] = context[currentShortName]
        }
        return context
    }

    /**
     * Shows a JEXL debug dialog and suspends until the user dismisses it.
     * Use this for places where we need to wait before proceeding (like eligibility checks).
     */
    private suspend fun showDebugDialogAndWait(
        statement: String,
        context: Map<String, Any?>,
        scriptType: String
    ) {
        if (!isJexlDebugEnabled()) return

        suspendCancellableCoroutine { continuation ->
            _jexlDebugRequest.value = JexlDebugRequest(
                statement = statement,
                context = context,
                scriptType = scriptType,
                onContinue = {
                    _jexlDebugRequest.value = null
                    continuation.resume(Unit)
                }
            )
        }
    }

    /**
     * Advance forward past questions hidden by their pre_script. A hidden
     * question is never shown or answered, so its validation_script,
     * skip_to_script, and history entry must NOT run — only its pre_script is
     * consulted. Use after a normal advance or a jump to settle on the first
     * visible question.
     */
    private fun advancePastHiddenQuestions() {
        val count = survey?.questions?.size ?: return
        while (currentQuestionIndex < count &&
               evaluateCurrentQuestionPreScript() == "skip") {
            currentQuestionIndex++
            updateCurrentQuestion()
        }
    }

    //@Composable
    //@OptIn(ExperimentalMaterial3Api::class)
    fun loadNextQuestion() : String? {
        Log.d("SurveyViewModel", "loadNextQuestion from question: $currentQuestionIndex")
        // Check multi-select validation first
        val multiSelectError = validateMultiSelectAnswer()
        if (multiSelectError != null) {
            Log.d("SurveyViewModel", "Multi-select validation failed: $multiSelectError")
            return multiSelectError
        }

        val valid = evaluateCurrentQuestionValidationScript()
        if(!valid){
            Log.d("SurveyViewModel", "Validation failed for question at index $currentQuestionIndex")
            val errorText = _currentQuestion?.value?.first?.validationErrorText ?: "Invalid Answer"
            return errorText
        }

        // Push current index to history before navigating forward
        if (currentQuestionIndex >= 0) {
            questionHistory.add(currentQuestionIndex)
            Log.d("SurveyViewModel", "Added question $currentQuestionIndex to history. History size: ${questionHistory.size}")
        }

        // Check for skip-to logic after validation passes
        val skipToTarget = evaluateSkipToLogic()
        if (skipToTarget != null) {
            Log.d("SurveyViewModel", "Skip-to logic triggered, jumping to: $skipToTarget")
            jumpToQuestionWithoutHistory(skipToTarget)
            return null
        }

        currentQuestionIndex++
        updateCurrentQuestion()
        // If we landed on a hidden question, move on. Do NOT recurse through
        // loadNextQuestion — a hidden question's skip_to/validation must not run.
        advancePastHiddenQuestions()
        return null
    }

    fun loadPreviousQuestion() {
        // Use history stack to go back to the actual previous question
        // This respects skip-to navigation - if user jumped from Q5 to Q20,
        // pressing back on Q20 should return to Q5, not Q19
        if (questionHistory.isNotEmpty()) {
            // removeAt(lastIndex) rather than removeLast(): with compileSdk 35 the Kotlin
            // compiler resolves MutableList.removeLast() to java.util.List.removeLast(),
            // which only exists on Android 15+ and crashes with NoSuchMethodError on older devices.
            currentQuestionIndex = questionHistory.removeAt(questionHistory.lastIndex)
            Log.d("SurveyViewModel", "Popped question $currentQuestionIndex from history. History size: ${questionHistory.size}")
            updateCurrentQuestion()
        } else if (currentQuestionIndex > 0) {
            // Fallback for edge cases (e.g., first question or history was cleared)
            Log.d("SurveyViewModel", "History empty, falling back to simple decrement")
            currentQuestionIndex--
            updateCurrentQuestion()
            val action = evaluateCurrentQuestionPreScript()
            if(action == "skip"){
                loadPreviousQuestion()
            }
        }
    }

    fun answerQuestion(optionId: Int) {
        if(survey == null)
            return

        val options = _currentQuestion.value?.second ?: return
        val option = options.find { it.id == optionId }
        val text = option?.text ?: return
        val optionIndex = option?.optionQuestionIndex
        survey!!.answers[currentQuestionIndex].optionQuestionIndex = optionIndex
        survey!!.answers[currentQuestionIndex].numericValue = optionIndex?.toDouble()
        survey!!.answers[currentQuestionIndex].answerPrimaryLanguageText = text
        _currentQuestion.value = _currentQuestion.value?.copy(third = survey!!.answers[currentQuestionIndex] )

        // Save answer immediately to database (survives Activity/ViewModel recreation)
        saveAnswerToDatabase(survey!!.answers[currentQuestionIndex])

        viewModelScope.launch {
            loadNextQuestion()
        }
    }

    // NEW: Overloaded answerQuestion for text/numeric input
    fun answerQuestion(textAnswer: String) {
        val answer = survey!!.answers[currentQuestionIndex]

        // isNumeric is already set based on question type at Answer creation time
        // Just set the values here
        answer.numericValue = textAnswer.toDoubleOrNull()
        answer.answerPrimaryLanguageText = textAnswer

        _currentQuestion.value = _currentQuestion.value?.copy(third = answer)

        // Save answer immediately to database (survives Activity/ViewModel recreation)
        saveAnswerToDatabase(answer)
    }
    
    // Handle multi-select option toggle
    fun toggleMultiSelectOption(optionIndex: Int) {
        if (survey == null) return
        
        val currentQuestion = _currentQuestion.value?.first ?: return
        val currentAnswer = survey!!.answers[currentQuestionIndex]
        
        // Get current selected indices
        val selectedIndices = currentAnswer.getSelectedIndices().toMutableList()
        
        if (selectedIndices.contains(optionIndex)) {
            // Remove if already selected
            selectedIndices.remove(optionIndex)
        } else {
            // Check if we can add more selections
            val maxSelections = currentQuestion.maxSelections
            if (maxSelections != null && selectedIndices.size >= maxSelections) {
                // Already at max selections, don't add
                return
            }
            selectedIndices.add(optionIndex)
        }
        
        // Create a new Answer object with updated selections to ensure UI recomposition
        val updatedAnswer = currentAnswer.copy(
            isMultiSelect = true,
            multiSelectIndices = selectedIndices.sorted().joinToString(",")
        )
        
        // Update the actual answer in the survey
        survey!!.answers[currentQuestionIndex] = updatedAnswer
        
        Log.d("SurveyViewModel", "Toggle multi-select: optionIndex=$optionIndex, selectedIndices=$selectedIndices, multiSelectIndices=${updatedAnswer.multiSelectIndices}")

        // Force recomposition by creating a new Triple with the new answer object
        // This ensures the UI detects the change because the answer reference has changed
        val updatedTriple = Triple(
            _currentQuestion.value!!.first,
            _currentQuestion.value!!.second,
            updatedAnswer
        )
        _currentQuestion.value = updatedTriple

        // Save answer immediately to database (survives Activity/ViewModel recreation)
        saveAnswerToDatabase(updatedAnswer)
    }
    
    // Validate multi-select answer
    fun validateMultiSelectAnswer(): String? {
        val currentQuestion = _currentQuestion.value?.first ?: return null
        
        // Only validate if it's a multi_select question
        if (currentQuestion.questionType != "multi_select") return null
        
        val currentAnswer = survey!!.answers[currentQuestionIndex]
        val selectedCount = currentAnswer.getSelectedIndices().size
        val minSelections = currentQuestion.minSelections
        val maxSelections = currentQuestion.maxSelections
        
        Log.d("SurveyViewModel", "Multi-select validation: selected=$selectedCount, min=$minSelections, max=$maxSelections")
        
        if (minSelections != null && selectedCount < minSelections) {
            return currentQuestion.validationErrorText ?: 
                "Please select at least $minSelections options"
        }
        
        if (maxSelections != null && selectedCount > maxSelections) {
            return currentQuestion.validationErrorText ?: 
                "Please select at most $maxSelections options"
        }
        
        return null
    }

    /**
     * Get the current language being used in the survey
     */
    fun getCurrentLanguage(): String {
        return survey?.language ?: "en"
    }

    /**
     * Get the staff validation message in the specified language
     * This would typically come from the survey configuration
     */
    fun getStaffValidationMessage(language: String): String? {
        // TODO: Get this from actual survey configuration once synced from server
        // For now, return a default message
        return when (language) {
            "es" -> "Por favor devuelva la tableta al miembro del personal que se la entregó"
            "fr" -> "Veuillez remettre la tablette au membre du personnel qui vous l'a donnée"
            else -> "Please hand the tablet back to the staff member who gave it to you"
        }
    }

    /**
     * Check if we've transitioned between sections
     * Returns true if navigation away from survey is needed (don't update current question)
     */
    private fun checkSectionTransition(question: Question) : Boolean {
        //viewModelScope.launch {
            try {
                var eligStatus = -1
                // Get the section for the current question
                val newSection = sections.firstOrNull { it.id == question.sectionId }

                if (newSection != null && newSection != currentSection) {
                    Log.d("SurveyViewModel", "Transitioning from section ${currentSection?.name} to ${newSection.name}")

                    // Check if we're leaving the eligibility section
                    if (currentSection?.sectionType == "eligibility" && newSection.sectionType != "eligibility") {
                        Log.d("SurveyViewModel", "Completed eligibility section, checking eligibility")
                        eligStatus = checkEligibility()
                    }

                    currentSection = newSection
                    // Return true if we're navigating away (rapid tests=2, consent=3, or debug dialog pending)
                    val navigatingAway = eligStatus == 2 || eligStatus == 3 || _pendingEligibilityDebug.value != null
                    if (navigatingAway) {
                        Log.d("SurveyViewModel", "Navigating away from survey (eligStatus=$eligStatus, debugPending=${_pendingEligibilityDebug.value != null})")
                    }
                    return navigatingAway
                }
            } catch (e: Exception) {
                Log.e("SurveyViewModel", "Error checking section transition", e)
            }
            return false
        //}
    }

    /**
     * Clear the eligibility check flag to continue with the survey
     * Also refreshes the current question to ensure audio plays
     */
    fun clearEligibilityCheck() {
        _needsEligibilityCheck.value = false
        // Refresh current question now that we're returning to survey
        // This ensures _currentQuestion.value is set and audio will play
        refreshCurrentQuestion()
    }

    /**
     * Refresh the current question state (for when returning from consent/rapid tests)
     * This sets _currentQuestion.value without triggering section transition checks
     */
    fun refreshCurrentQuestion() {
        if (survey == null || currentQuestionIndex < 0 || currentQuestionIndex >= questions.size) {
            return
        }
        Log.d("SurveyViewModel", "Refreshing current question at index: $currentQuestionIndex")
        val question = questions[currentQuestionIndex]
        val options = database.surveyDao().getOptionsForQuestion(question.id)
        _currentQuestion.value = Triple(question, options, survey!!.answers[currentQuestionIndex])
    }

    /**
     * Evaluate the eligibility script to determine if the participant is eligible
     */
    private fun checkEligibility() : Int {
        var returnValue = -1
        val eligibilityScript = survey?.eligibilityScript

        try {
            val context = buildJexlContext()

            var eligible = true
            if (!eligibilityScript.isNullOrBlank()) {
                val result = evaluateJexlScript(eligibilityScript, context)
                eligible = when (result) {
                    is Boolean -> result
                    is Number -> result.toInt() != 0
                    is String -> result.equals("true", ignoreCase = true) || result == "1"
                    null -> false
                    else -> result.toString().equals("true", ignoreCase = true)
                }

                // Show debug dialog if enabled - store context for showing after navigation pauses
                // Skip if we're re-entering after debug dialog was dismissed
                if (isJexlDebugEnabled() && !skipEligibilityDebug) {
                    // Store the pending eligibility debug info
                    _pendingEligibilityDebug.value = Triple(eligibilityScript, context, eligible)
                }
                // Reset skip flag after use
                skipEligibilityDebug = false
            }else{
                Log.d("SurveyViewModel", "No eligibility script defined, defaulting to eligible")
            }

            Log.d("SurveyViewModel", "Eligibility check result: $eligible (script: $eligibilityScript)")
            _isEligible.value = eligible
            _needsEligibilityCheck.value = true
            returnValue = if (eligible) 1 else 0

            // If debug dialog is pending, don't proceed with consent navigation yet
            // The UI will show the dialog first, and when dismissed, this code path will be re-run
            if (_pendingEligibilityDebug.value != null) {
                Log.d("SurveyViewModel", "Debug dialog pending - deferring consent/navigation")
                return returnValue
            }

            // For staff screening mode: check if consent is needed after eligibility passes
            if (eligible) {
                val surveyConfig = database.surveyConfigDao().getSurveyConfig()
                val staffEligibilityScreening = surveyConfig?.staffEligibilityScreening ?: false
                val existingSignature = survey?.consentSignaturePath

                if (staffEligibilityScreening && existingSignature.isNullOrBlank()) {
                    Log.d("SurveyViewModel", "Staff screening mode: consent needed after eligibility")
                    _needsConsentAfterEligibility.value = true
                    // consent needed; the rapid-test handoff happens AFTER
                    // consent — see ConsentSignatureScreen's returnTo="survey".
                    return 3
                }
            }

            // Check if rapid tests are needed after eligibility
            if (eligible && !_rapidTestsCompleted.value) {
                //viewModelScope.launch(Dispatchers.IO) {
                    // Get the actual survey ID from sections (all sections have the same survey ID)
                    // If no sections exist, use -1 to ensure we error out rather than use wrong data
                    val sections = database.sectionDao().getAllSections()
                    val actualSurveyId = sections.firstOrNull()?.surveyId?.toLong() ?: -1L

                    if (actualSurveyId == -1L) {
                        Log.e("SurveyViewModel", "CRITICAL ERROR: No sections found in database - survey not properly synced!")
                        Log.e("SurveyViewModel", "Using fallback survey ID -1, rapid tests will not be found")
                        Log.e("SurveyViewModel", "Please ensure survey is properly downloaded from server")
                    }

                    // Check if rapid test samples should be collected after eligibility
                    val surveyConfig = database.surveyConfigDao().getSurveyConfig()
                    val rapidTestSamplesAfterEligibility = surveyConfig?.rapidTestSamplesAfterEligibility ?: true
                    val enabledTests = database.testConfigurationDao().getEnabledTestConfigurations(actualSurveyId)

                    if (!rapidTestSamplesAfterEligibility) {
                        // Samples will be collected at end of survey - but still need to show tablet handoff
                        Log.d("SurveyViewModel", "Rapid test samples after eligibility disabled - will show tablet handoff screen")
                        _needsRapidTestsAfterEligibility.value = false

                        // Emit navigation event to show tablet handoff screen
                        if (!hasNavigatedToRapidTests) {
                            hasNavigatedToRapidTests = true
                            returnValue = 2
                            viewModelScope.launch {
                                _navigationEvent.emit(SurveyNavigationEvent.NavigateToRapidTests)
                            }
                            Log.d("SurveyViewModel", "Emitting NavigateToRapidTests event for tablet handoff")
                        }
                    } else {
                        // Check if any tests are enabled for the actual survey
                        if (enabledTests.isNotEmpty()) {
                            Log.d("SurveyViewModel", "${enabledTests.size} rapid tests enabled for survey ID $actualSurveyId - will need to perform tests")
                            _needsRapidTestsAfterEligibility.value = true

                            // Emit navigation event if we haven't already
                            if (!hasNavigatedToRapidTests) {
                                hasNavigatedToRapidTests = true
                                returnValue = 2
                                viewModelScope.launch {
                                    _navigationEvent.emit(SurveyNavigationEvent.NavigateToRapidTests)
                                }
                                //_navigationEvent.emit(SurveyNavigationEvent.NavigateToRapidTests)
                                Log.d("SurveyViewModel", "Emitting NavigateToRapidTests event")
                            }
                        }
                    }
                //}
            }
        } catch (e: Exception) {
            Log.e("SurveyViewModel", "Error evaluating eligibility script", e)
            // Default to eligible on error to avoid blocking participants
            _isEligible.value = true
            _needsEligibilityCheck.value = false
        }
        return returnValue
    }

    /**
     * Called when eligibility check is acknowledged and survey should continue
     */
    fun acknowledgeEligibilityCheck() {
        _needsEligibilityCheck.value = false
        // Continue with next question
        // The navigation will be handled by the SurveyScreen
    }

    /**
     * Called when HIV test has been completed and survey should continue (deprecated)
     */
    fun markHivTestCompleted() {
        _hivTestCompleted.value = true
        _needsHivTestAfterEligibility.value = false
        Log.d("SurveyViewModel", "HIV test marked as completed")
    }

    /**
     * Called when all rapid tests have been completed and survey should continue
     */
    fun markRapidTestsCompleted() {
        _rapidTestsCompleted.value = true
        _needsRapidTestsAfterEligibility.value = false
        hasNavigatedToRapidTests = false  // Reset for potential future use
        Log.d("SurveyViewModel", "All rapid tests marked as completed")
    }

    /**
     * Reset eligibility check state (useful for testing)
     */
    fun resetEligibilityCheck() {
        _needsEligibilityCheck.value = false
        _isEligible.value = null
    }

}

