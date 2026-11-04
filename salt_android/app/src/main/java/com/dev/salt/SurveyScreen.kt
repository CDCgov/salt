/**
 * Survey Screen
 *
 * The main survey interview interface for the SALT Android application.
 * This screen handles the core data collection workflow with audio-assisted
 * questions (ACASI), multi-language support, and various question types.
 *
 * Key Features:
 * - Audio-Computer Assisted Self-Interview (ACASI) with automatic playback
 * - Multiple question types: multiple choice, multi-select, numeric, text
 * - Sequential audio playback for questions and options with visual highlighting
 * - Answer validation preventing incomplete submissions
 * - Skip logic evaluation using JEXL expressions
 * - Previous/Next navigation with answer persistence
 * - Eligibility check integration with ineligibility handling
 * - Survey state tracking to prevent accidental data loss
 * - Automatic progression to payment confirmation on completion
 *
 * Question Types Supported:
 * 1. multiple_choice: Single selection with button interface
 * 2. multi_select: Multiple selections with checkboxes (min/max constraints)
 * 3. numeric: Number input with validation
 * 4. text: Free-form text input
 *
 * Audio Playback Flow:
 * 1. Question audio plays first (with replay button)
 * 2. Each option audio plays sequentially
 * 3. Visual highlighting (yellow) shows which option is currently playing
 * 4. Selected answer shows with green highlight
 * 5. User can replay question/options at any time
 *
 * Answer Validation:
 * - Next button only enabled when current question answered
 * - Multi-select validates min/max selections
 * - Numeric input validates format
 * - Cannot skip required questions
 *
 * Navigation Flow:
 * 1. Questions displayed one at a time
 * 2. Previous button allows navigation back (answers preserved)
 * 3. Next button advances (only if answered)
 * 4. Skip logic may skip questions based on previous answers
 * 5. Eligibility check may end survey early for ineligible participants
 * 6. Survey completion triggers coupon generation and payment confirmation
 *
 * State Management:
 * - Uses SurveyViewModel for business logic and data persistence
 * - SurveyStateManager tracks active survey to prevent logout
 * - Answers saved immediately to database on selection
 * - Text inputs saved on navigation
 * - Progress tracked for resume capability
 *
 * Related Components:
 * - SurveyViewModel.kt: Business logic and database operations
 * - EligibilityCheckScreen.kt: Handles ineligibility display
 * - RapidTestScreen.kt: HIV rapid test after eligibility
 * - SubjectPaymentScreen.kt: Payment confirmation after survey
 * - SurveyStateManager.kt: Tracks survey session state
 *
 * Database:
 * - Reads: questions, options, answers (for resuming)
 * - Writes: answers, survey responses
 *
 * MediaPlayer Management:
 * - Sequential playback with suspend functions
 * - Automatic cleanup on completion
 * - Stop and release on navigation
 * - Replay functionality for accessibility
 *
 * @see SurveyViewModel
 * @see EligibilityCheckScreen
 * @see SurveyStateManagerInstance
 */

package com.dev.salt

import android.media.MediaPlayer
import com.dev.salt.logging.AppLogger as Log
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Checkbox
import androidx.compose.ui.Alignment
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.dev.salt.viewmodel.SurveyViewModel
import com.dev.salt.viewmodel.SurveyCompletionState
import com.dev.salt.playAudio
import kotlinx.coroutines.flow.first
import com.dev.salt.session.SurveyStateManagerInstance
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
import com.dev.salt.ui.EligibilityCheckScreen
import com.dev.salt.ui.JexlDebugDialog
import com.dev.salt.ui.components.MarkdownText
import androidx.compose.ui.res.stringResource
import androidx.activity.compose.BackHandler

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun SurveyScreen(
    viewModel: SurveyViewModel,
    coroutineScope: CoroutineScope,
    onNavigateBack: () -> Unit = {},
    onNavigateToHivTest: () -> Unit = {},
    onNavigateToRapidTests: () -> Unit = {},
    onNavigateToConsent: (String) -> Unit = {}
) {
    //var currentQuestion = viewModel.currentQuestion
    val context = LocalContext.current
    val currentQuestion by viewModel.currentQuestion.collectAsState()
    var highlightedButtonIndex by remember { mutableStateOf<Int?>(null) }
    //var mediaPlayer: MediaPlayer? = remember { null }
    var currentMediaPlayer: MediaPlayer? by remember { mutableStateOf(null) }
    var audioJob: Job? by remember { mutableStateOf(null) }
    val lifecycleOwner = LocalLifecycleOwner.current

    val surveyStateManager = SurveyStateManagerInstance.instance

    // Disable hardware back button during survey to prevent accidental exits
    BackHandler(enabled = true) {
        // Intentionally empty - system back button is disabled during survey
    }

    // Observe eligibility check states
    val needsEligibilityCheck by viewModel.needsEligibilityCheck.collectAsState()
    val isEligible by viewModel.isEligible.collectAsState()
    val eligibilityScriptError by viewModel.eligibilityScriptError.collectAsState()

    // Observe pending eligibility debug dialog
    val pendingEligibilityDebug by viewModel.pendingEligibilityDebug.collectAsState()

    // Observe consent needed after eligibility (staff screening mode)
    val needsConsentAfterEligibility by viewModel.needsConsentAfterEligibility.collectAsState()

    // Observe rapid tests needed after eligibility
    val needsRapidTestsAfterEligibility by viewModel.needsRapidTestsAfterEligibility.collectAsState()

    // Observe HIV test requirement after eligibility (deprecated - for backward compatibility)
    val needsHivTestAfterEligibility by viewModel.needsHivTestAfterEligibility.collectAsState()

    // Collect navigation events from the ViewModel
    LaunchedEffect(Unit) {
        viewModel.navigationEvent.collect { event ->
            when (event) {
                is com.dev.salt.viewmodel.SurveyNavigationEvent.NavigateToRapidTests -> {
                    Log.d("SurveyScreen", "Received NavigateToRapidTests event")
                    onNavigateToRapidTests()
                }
                is com.dev.salt.viewmodel.SurveyNavigationEvent.NavigateToHivTest -> {
                    Log.d("SurveyScreen", "Received NavigateToHivTest event")
                    onNavigateToHivTest()
                }
            }
        }
    }

    // JEXL Debug Dialog - render early so it's available before any returns
    // This must be rendered before any early returns so the dialog can actually show
    val jexlDebugRequest by viewModel.jexlDebugRequest.collectAsState()
    jexlDebugRequest?.let { request ->
        JexlDebugDialog(
            originalStatement = request.statement,
            context = request.context,
            scriptType = request.scriptType,
            onContinue = {
                viewModel.clearJexlDebugRequest()
                request.onContinue()
            }
        )
    }

    // Handle eligibility debug dialog first - before any navigation happens
    // This must come before consent navigation to intercept the flow
    if (pendingEligibilityDebug != null) {
        LaunchedEffect(Unit) {
            viewModel.showPendingEligibilityDebug()
        }
        // The jexlDebugRequest dialog is rendered above - show it and wait for dismiss
        // Don't proceed with the rest of the UI until dialog is dismissed
        return
    }

    // Handle consent needed after eligibility (staff screening mode)
    LaunchedEffect(needsConsentAfterEligibility) {
        if (needsConsentAfterEligibility) {
            val surveyId = viewModel.survey?.id ?: ""
            Log.d("SurveyScreen", "Consent needed after eligibility - navigating to consent for survey: $surveyId")
            viewModel.clearConsentNeeded()
            onNavigateToConsent(surveyId)
        }
    }

    // Handle eligibility check
    if (needsEligibilityCheck) {
        if (isEligible == true) {
            // If eligible, just continue automatically
            // But don't clear if we're navigating away (consent or rapid tests) - that will clear when we return
            val navigatingAway = needsConsentAfterEligibility || needsRapidTestsAfterEligibility
            if (!navigatingAway) {
                LaunchedEffect(Unit) {
                    viewModel.clearEligibilityCheck()
                }
            }
        } else {
            // If not eligible, show the eligibility check screen
            EligibilityCheckScreen(
                surveyId = viewModel.survey?.id ?: "",
                isEligible = false,
                onContinue = {
                    // This shouldn't be called for ineligible participants
                },
                onCancel = {
                    // End survey and navigate back
                    surveyStateManager.endSurvey()
                    onNavigateBack()
                }
            )
            // The eligibility script errored: the participant is still treated
            // as not eligible, but tell staff so the survey setup gets fixed.
            if (eligibilityScriptError) {
                AlertDialog(
                    onDismissRequest = { },
                    title = { Text(stringResource(R.string.eligibility_script_error_title)) },
                    text = { Text(stringResource(R.string.eligibility_script_error_message)) },
                    confirmButton = {
                        TextButton(onClick = { viewModel.clearEligibilityScriptError() }) {
                            Text(stringResource(R.string.common_ok))
                        }
                    }
                )
            }
            return // Don't show the survey questions
        }
    }

    // Track survey state
    LaunchedEffect(viewModel.survey) {
        viewModel.survey?.let { survey ->
            surveyStateManager.startSurvey(survey.id, viewModel.questions.size)
        }
    }
    
    // Update question progress
    LaunchedEffect(viewModel.currentQuestionIndex) {
        if (viewModel.currentQuestionIndex >= 0) {
            surveyStateManager.updateQuestionProgress(viewModel.currentQuestionIndex)
        }
    }
    
    // End survey when completed and navigate back
    // Use proper async coordination via SurveyCompletionState instead of polling
    LaunchedEffect(currentQuestion) {
        if (currentQuestion == null && viewModel.currentQuestionIndex >= 0) {
            surveyStateManager.endSurvey()

            // Wait for completion state to be Completed or Failed
            // This properly awaits the ViewModel's coroutine without polling
            val completionState = viewModel.surveyCompletionState.first { state ->
                state is SurveyCompletionState.Completed || state is SurveyCompletionState.Failed
            }

            when (completionState) {
                is SurveyCompletionState.Completed -> {
                    Log.d("SurveyScreen", "Survey completed with ${completionState.coupons.size} coupons")
                }
                is SurveyCompletionState.Failed -> {
                    Log.e("SurveyScreen", "Survey completion failed: ${completionState.error}")
                }
                else -> { /* NotCompleted or Saving - shouldn't reach here */ }
            }

            // Brief pause to show completion message before navigating
            kotlinx.coroutines.delay(1000)
            onNavigateBack()
        }
    }

    // State for the text field input, resets when question ID changes
    var textInputValue by rememberSaveable(currentQuestion?.first?.id) {
        mutableStateOf(
            // MODIFIED: Initialize with existing text answer if available
            currentQuestion?.let { (q, _, ans) ->
                if (q.questionType != "multiple_choice") ans?.getValue(false)?.toString() else ""
            } ?: ""
        )
    }

    // Check if current question is answered
    val isQuestionAnswered by remember(currentQuestion, textInputValue) {
        derivedStateOf {
            currentQuestion?.let { (question, _, answer) ->
                when (question.questionType) {
                    "info" -> true  // Info questions are always "answered" - no input required
                    "multiple_choice" -> answer?.optionQuestionIndex != null
                    "multi_select" -> {
                        val selectedIndices = answer?.getSelectedIndices() ?: emptyList()
                        selectedIndices.isNotEmpty()
                    }
                    // A lone "-" or "." passes the input filter but is not a number
                    "numeric" -> textInputValue.trim().toDoubleOrNull() != null
                    "text" -> textInputValue.trim().isNotEmpty()
                    else -> false
                }
            } ?: false
        }
    }
    
    // Track unsaved changes
    LaunchedEffect(textInputValue) {
        if (textInputValue.isNotEmpty()) {
            surveyStateManager.markUnsavedChanges()
        }
    }

    // Update textInputValue when currentQuestionData changes and it's a text-based answer
    // This handles loading previous answers when navigating back/forth
    LaunchedEffect(currentQuestion) {
        currentQuestion?.let { (question, _, answer) ->
            if (question.questionType != "multiple_choice") {
                textInputValue = answer?.getValue(false)?.toString() ?: ""
            }
        }
    }

    var errorMessageForDialog by remember { mutableStateOf<String?>(null) }
    var showDialog by remember { mutableStateOf(false) }

    LaunchedEffect(errorMessageForDialog) {
        if (errorMessageForDialog != null) {
            showDialog = true // Trigger the dialog to show
        }
        // You might not want to set showDialog = false here,
        // as the dialog's own dismiss actions will handle that.
    }

    if (showDialog) {
        AlertDialog(
            onDismissRequest = {
                showDialog = false
                errorMessageForDialog = null // Clear the error when dialog is dismissed
            },
            title = { Text(stringResource(R.string.survey_error_icon)) }, // Or a more dynamic title
            text = { Text(errorMessageForDialog ?: stringResource(R.string.survey_error_default)) }, // Use the state variable
            confirmButton = {
                TextButton(
                    onClick = {
                        showDialog = false
                        errorMessageForDialog = null // Clear the error
                    }
                ) {
                    Text(stringResource(R.string.common_ok))
                }
            }
        )
    }

    // Note: JEXL Debug Dialog is now rendered earlier (before any early returns)
    // to ensure it can display for eligibility debug before the return statement

    suspend fun playCurrentQuestion(){
        currentQuestion?.let { (question, options, _) ->
            // Stop and release previous MediaPlayer
            try {
                currentMediaPlayer?.stop()
                currentMediaPlayer?.release()
                currentMediaPlayer = null
            } catch (e: Exception){ }

            // Bail before starting a new player if the coroutine was cancelled
            // (e.g. screen paused). playAudio is non-suspending so cancellation
            // wouldn't otherwise be checked between the stop above and start below.
            currentCoroutineContext().ensureActive()

            // Play question audio and wait for completion
            currentMediaPlayer = playAudio(context, question.audioFileName) // Store new MediaPlayer
            currentMediaPlayer?.let { player ->
                player.setOnCompletionListener {
                    it.release()
                    currentMediaPlayer = null // Reset after completion
                }
                player.start()
                player.awaitCompletion() // Suspend until completion
            }

            // Play option audios sequentially
            for (option in options) {
                withContext(Dispatchers.Main) {
                    highlightedButtonIndex = option.id
                }
                // Stop and release previous MediaPlayer for options
                currentMediaPlayer?.stop()
                currentMediaPlayer?.release()
                currentMediaPlayer = null

                currentCoroutineContext().ensureActive()

                currentMediaPlayer = playAudio(context, option.audioFileName) // Store new MediaPlayer
                currentMediaPlayer?.let { player ->
                    player.setOnCompletionListener {
                        it.release()
                        currentMediaPlayer = null // Reset after completion
                    }
                    player.start()
                    player.awaitCompletion() // Suspend until completion
                }
                withContext(Dispatchers.Main) {
                    highlightedButtonIndex = null
                }
            }
        }
    }

    fun stopAudioPlayback() {
        audioJob?.cancel()
        audioJob = null
        try {
            currentMediaPlayer?.stop()
            currentMediaPlayer?.release()
        } catch (e: Exception) {
            Log.e("SurveyScreen", "Error stopping audio", e)
        }
        currentMediaPlayer = null
    }

    fun launchAudioPlayback() {
        audioJob?.cancel()
        // Don't start playback if the screen is not currently visible. The
        // ViewModel may advance currentQuestion at the same moment it triggers
        // a forward navigation; without this gate, LaunchedEffect(currentQuestion)
        // can fire after ON_PAUSE has already been dispatched, starting audio
        // on a paused screen that the lifecycle observer will never see again.
        if (!lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
            return
        }
        audioJob = coroutineScope.launch {
            playCurrentQuestion()
        }
    }

    LaunchedEffect(currentQuestion) {
        launchAudioPlayback()
    }

    // Tie audio playback to screen visibility. Forward navigation keeps this
    // composable in composition, so DisposableEffect alone wouldn't fire — the
    // lifecycle events are the reliable signal.
    //   ON_PAUSE  → stop any audio (screen no longer visible).
    //   ON_RESUME → start the current question's audio. This covers the case
    //               where the ViewModel advances currentQuestion at the same
    //               moment it triggers a forward navigation; the initial
    //               LaunchedEffect(currentQuestion) is gated out by the
    //               not-RESUMED check, so we need ON_RESUME to start it once
    //               the user returns (e.g. after consent or a rapid test).
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_PAUSE -> stopAudioPlayback()
                Lifecycle.Event.ON_RESUME -> launchAudioPlayback()
                else -> { }
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            stopAudioPlayback()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.survey_title)) },
                actions = {
                    IconButton(onClick = { /* Handle exit action */ }) {
                        Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.cd_exit))
                    }
                }
            )
        },
        bottomBar = {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Button(onClick = {
                    currentQuestion?.let { (question, _, _) ->
                        // Don't save answer for info or multiple_choice types
                        if (question.questionType != "multiple_choice" && question.questionType != "info") {
                            viewModel.answerQuestion(textInputValue)
                        }
                    }
                    viewModel.loadPreviousQuestion()
                }, enabled = viewModel.hasPreviousQuestion.value) {
                    Text(stringResource(R.string.common_previous))
                }
                Button(onClick = {
                    currentQuestion?.let { (question, _, _) ->
                        // Don't save answer for info or multiple_choice types
                        if (question.questionType != "multiple_choice" && question.questionType != "info") {
                            viewModel.answerQuestion(textInputValue)
                        }
                    }
                    val message = viewModel.loadNextQuestion()
                    if(message != null){
                        errorMessageForDialog = message
                        showDialog = true // Show the dialog with the error message
                    }


                    //currentQuestion = viewModel.currentQuestion

                }, enabled = isQuestionAnswered) {
                    Text(stringResource(R.string.common_next))
                }
            }
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .padding(innerPadding)
                .padding(16.dp)
        ) {
            val currentQuestion by viewModel.currentQuestion.collectAsState()
            currentQuestion?.let { (question, options, answer) ->
                MarkdownText(
                    markdown = question.statement,
                    modifier = Modifier.fillMaxWidth(),
                    baseStyle = MaterialTheme.typography.headlineSmall,
                )
                Spacer(modifier = Modifier.height(16.dp))

                // Replay button
                IconButton(onClick = {
                    launchAudioPlayback()
                }) { // Replay logic
                    Icon(Icons.Filled.Replay, contentDescription = stringResource(R.string.cd_replay))
                }
                if (question.questionType == "info") {
                    // Info type: Display only - no input controls needed
                    // The question statement is already displayed above
                    // Just show a spacer for visual balance
                    Spacer(modifier = Modifier.height(16.dp))
                } else if (question.questionType == "multiple_choice") {
                    options.forEach { option ->
                        val isHighlighted by remember(highlightedButtonIndex, option.id)
                        { // Derived state
                            derivedStateOf { highlightedButtonIndex == option.id }
                        }
                        val buttonColors = if (isHighlighted) {
                            ButtonDefaults.buttonColors(containerColor = Color.Yellow)
                        } else if (answer?.numericValue?.toInt() == option.optionQuestionIndex) { // Check for match
                            ButtonDefaults.buttonColors(containerColor = Color.Green) // Change color if match
                        } else {
                            ButtonDefaults.buttonColors() // Default color
                        }
                        Button(
                            onClick = {
                                viewModel.answerQuestion(option.id)
                                      },
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 8.dp),
                            colors = buttonColors // Apply button colors
                        ) {
                            // Inline markdown (bold/italic) supported; inherits the
                            // button's content color so it still flips on highlight/select.
                            MarkdownText(markdown = option.text)
                        }
                    }
                } else if (question.questionType == "multi_select") {
                    // Multi-select with checkboxes
                    // Get the current answer directly from the Triple to ensure reactivity
                    val currentAnswer = currentQuestion?.third
                    val selectedIndices = currentAnswer?.getSelectedIndices() ?: emptyList()
                    
                    // Debug logging
                    LaunchedEffect(selectedIndices) {
                        com.dev.salt.logging.AppLogger.d("SurveyScreen", "Multi-select UI: selectedIndices=$selectedIndices")
                    }
                    
                    // Show min/max selection info if applicable
                    val minSel = question.minSelections
                    val maxSel = question.maxSelections
                    if (minSel != null || maxSel != null) {
                        Text(
                            text = when {
                                minSel == maxSel && minSel != null ->
                                    stringResource(R.string.survey_multiselect_exact, minSel)
                                minSel != null && maxSel != null ->
                                    stringResource(R.string.survey_multiselect_range, minSel, maxSel)
                                minSel != null ->
                                    stringResource(R.string.survey_multiselect_min, minSel)
                                maxSel != null ->
                                    stringResource(R.string.survey_multiselect_max, maxSel)
                                else -> ""
                            },
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.padding(bottom = 8.dp)
                        )
                    }
                    
                    options.forEach { option ->
                        val isSelected = selectedIndices.contains(option.optionQuestionIndex)
                        val isHighlighted by remember(highlightedButtonIndex, option.id) {
                            derivedStateOf { highlightedButtonIndex == option.id }
                        }
                        
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 4.dp)
                                .background(
                                    if (isHighlighted) Color.Yellow.copy(alpha = 0.3f) 
                                    else Color.Transparent
                                )
                                .clickable {
                                    viewModel.toggleMultiSelectOption(option.optionQuestionIndex)
                                },
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Checkbox(
                                checked = isSelected,
                                onCheckedChange = {
                                    viewModel.toggleMultiSelectOption(option.optionQuestionIndex)
                                }
                            )
                            MarkdownText(
                                markdown = option.text,
                                modifier = Modifier.padding(start = 8.dp)
                            )
                        }
                    }
                } else{
                    // Text Field for numeric or freeform text
                    OutlinedTextField(
                        value = textInputValue,
                        onValueChange = { newValue ->
                            if (question.questionType == "numeric") {
                                if (newValue.matches(Regex("^-?\\d*\\.?\\d*\$"))) {
                                    textInputValue = newValue
                                }
                            } else {
                                // For freeform text, allow any input
                                textInputValue = newValue
                            }
                        },
                        label = { Text("") },
                        modifier = Modifier.fillMaxWidth(),
                        keyboardOptions = KeyboardOptions(
                            keyboardType = if (question.questionType == "numeric") KeyboardType.Number else KeyboardType.Text,
                            imeAction = ImeAction.Done // Or ImeAction.Next
                        ),
                        singleLine = question.questionType == "numeric", // Or false for multi-line free text
                        // NEW: Save on focus lost (optional, good for UX)
                        // onFocusChanged = { focusState ->
                        //    if (!focusState.isFocused && textInputValue != (answer?.getValue(false)?.toString() ?: "")) {
                        //        viewModel.answerQuestion(textInputValue)
                        //    }
                        // }
                    )
                    Spacer(modifier = Modifier.height(16.dp))
                }
            } ?: Text(stringResource(R.string.survey_completed), style = MaterialTheme.typography.headlineMedium)
        }
    }
}