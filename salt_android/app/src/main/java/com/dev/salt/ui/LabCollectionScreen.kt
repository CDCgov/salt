package com.dev.salt.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Science
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.res.stringResource
import com.dev.salt.R
import com.dev.salt.data.LabTestConfiguration
import com.dev.salt.data.SurveyDatabase
import com.dev.salt.debug.DeveloperSettingsManager
import com.dev.salt.util.JexlContextDebugInfo
import com.dev.salt.util.LabTestEvaluationResult
import com.dev.salt.util.LabTestJexlEvaluator
import androidx.activity.compose.BackHandler

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LabCollectionScreen(
    surveyId: String,
    subjectId: String,
    onSamplesCollected: () -> Unit,
    onCancel: () -> Unit,
    onBack: () -> Unit
) {
    // Disable hardware back button during survey flow
    BackHandler(enabled = true) {
        // Intentionally empty - back button is disabled during survey flow
    }

    val context = LocalContext.current
    val database = remember { SurveyDatabase.getInstance(context) }
    val scrollState = rememberScrollState()

    // State for lab tests and debug info
    var qualifyingTests by remember { mutableStateOf<List<LabTestConfiguration>>(emptyList()) }
    var debugInfo by remember { mutableStateOf<Pair<JexlContextDebugInfo, List<LabTestEvaluationResult>>?>(null) }
    var isLoading by remember { mutableStateOf(true) }
    var showDebugPanel by remember { mutableStateOf(false) }
    var shouldSkip by remember { mutableStateOf(false) }

    // JEXL Debug Dialog state for developer settings
    var currentDebugDialogIndex by remember { mutableStateOf(-1) }
    val isJexlDebugEnabled = remember { DeveloperSettingsManager.isJexlDebugEnabled(context) }

    // Load qualifying lab tests
    LaunchedEffect(surveyId) {
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            val (contextInfo, results) = LabTestJexlEvaluator.getDebugInfo(surveyId, database)
            debugInfo = Pair(contextInfo, results)
            val qualifying = results.filter { it.shouldShow }.map { it.labTest }
            qualifyingTests = qualifying

            // If no qualifying tests, auto-skip this screen
            if (qualifying.isEmpty()) {
                com.dev.salt.logging.AppLogger.d("LabCollectionScreen", "No qualifying lab tests - auto-skipping screen")
                shouldSkip = true
            }
            isLoading = false

            // If JEXL debug is enabled and there are results with conditions, start showing dialogs
            if (isJexlDebugEnabled && results.any { !it.jexlCondition.isNullOrBlank() && it.jexlCondition != "null" }) {
                currentDebugDialogIndex = 0
            }
        }
    }

    // Auto-skip if no qualifying tests (but wait for debug dialogs to finish first)
    LaunchedEffect(shouldSkip, isLoading, currentDebugDialogIndex) {
        if (shouldSkip && !isLoading && currentDebugDialogIndex < 0) {
            com.dev.salt.logging.AppLogger.d("LabCollectionScreen", "Auto-navigating past lab collection (no qualifying tests)")
            onSamplesCollected() // Proceed to next screen as if samples were collected
        }
    }

    // JEXL Debug Dialog for lab tests - shows one dialog per lab test with JEXL condition
    if (currentDebugDialogIndex >= 0 && debugInfo != null) {
        val results = debugInfo!!.second
        val contextMap = debugInfo!!.first.combinedContext

        // Find the next result with a JEXL condition
        val resultsWithConditions = results.filter { !it.jexlCondition.isNullOrBlank() && it.jexlCondition != "null" }

        if (currentDebugDialogIndex < resultsWithConditions.size) {
            val result = resultsWithConditions[currentDebugDialogIndex]
            JexlDebugDialog(
                originalStatement = result.jexlCondition ?: "",
                context = contextMap,
                scriptType = "Lab Test: ${result.labTest.testName}",
                onContinue = {
                    // Move to next dialog or close
                    if (currentDebugDialogIndex + 1 < resultsWithConditions.size) {
                        currentDebugDialogIndex++
                    } else {
                        currentDebugDialogIndex = -1 // Close dialogs
                    }
                }
            )
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Default.Science,
                            contentDescription = stringResource(R.string.cd_lab),
                            tint = Color.White
                        )
                        Text(stringResource(R.string.lab_title))
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.common_back),
                            tint = Color.White
                        )
                    }
                },
                actions = {
                    // Debug toggle button
                    IconButton(onClick = { showDebugPanel = !showDebugPanel }) {
                        Icon(
                            imageVector = Icons.Default.BugReport,
                            contentDescription = stringResource(R.string.lab_toggle_debug),
                            tint = if (showDebugPanel) Color.Yellow else Color.White
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color(0xFF1976D2),
                    titleContentColor = Color.White
                )
            )
        }
    ) { paddingValues ->
        if (isLoading) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues),
                contentAlignment = Alignment.Center
            ) {
                CircularProgressIndicator()
            }
        } else {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues)
                    .verticalScroll(scrollState)
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                // (Subject ID card removed — the inline ID badge in step 2
                // of the Instructions section is the only place the ID is
                // shown now, so the staff focuses on the one they need to
                // write on the tubes.)

                // Required Lab Tests Card
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = Color(0xFFE3F2FD))
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp)
                    ) {
                        Text(
                            text = stringResource(R.string.lab_required_tests, qualifyingTests.size),
                            fontWeight = FontWeight.Bold,
                            fontSize = 18.sp,
                            color = Color(0xFF1565C0)
                        )
                        Spacer(modifier = Modifier.height(12.dp))

                        if (qualifyingTests.isEmpty()) {
                            Text(
                                text = stringResource(R.string.lab_no_tests_message),
                                fontSize = 14.sp,
                                color = Color.Gray,
                                fontStyle = androidx.compose.ui.text.font.FontStyle.Italic
                            )
                        } else {
                            qualifyingTests.forEachIndexed { index, labTest ->
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Icon(
                                        imageVector = Icons.Default.CheckCircle,
                                        contentDescription = null,
                                        tint = Color(0xFF4CAF50),
                                        modifier = Modifier.size(24.dp)
                                    )
                                    Spacer(modifier = Modifier.width(12.dp))
                                    Column {
                                        Text(
                                            text = labTest.testName,
                                            fontWeight = FontWeight.Medium,
                                            fontSize = 16.sp
                                        )
                                        if (labTest.testCode != null) {
                                            Text(
                                                text = stringResource(R.string.lab_test_code, labTest.testCode),
                                                fontSize = 12.sp,
                                                color = Color.Gray
                                            )
                                        }
                                        Text(
                                            text = when (labTest.testType) {
                                                "numeric" -> stringResource(R.string.lab_test_type_numeric, labTest.unit?.let { " ($it)" } ?: "")
                                                "dropdown" -> stringResource(R.string.lab_test_type_dropdown)
                                                else -> stringResource(R.string.lab_test_type_generic, labTest.testType)
                                            },
                                            fontSize = 12.sp,
                                            color = Color.Gray
                                        )
                                    }
                                }
                                if (index < qualifyingTests.size - 1) {
                                    HorizontalDivider(
                                        modifier = Modifier.padding(vertical = 4.dp),
                                        color = Color(0xFFBBDEFB)
                                    )
                                }
                            }
                        }
                    }
                }

                // Debug Panel (collapsible)
                if (showDebugPanel && debugInfo != null) {
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = Color(0xFFFFF3E0))
                    ) {
                        Column(
                            modifier = Modifier.padding(16.dp)
                        ) {
                            Text(
                                text = stringResource(R.string.lab_debug_title),
                                fontWeight = FontWeight.Bold,
                                fontSize = 16.sp,
                                color = Color(0xFFE65100)
                            )
                            Spacer(modifier = Modifier.height(8.dp))

                            // Context Variables
                            Text(
                                text = stringResource(R.string.lab_debug_survey_answers),
                                fontWeight = FontWeight.SemiBold,
                                fontSize = 14.sp
                            )
                            val contextInfo = debugInfo!!.first
                            if (contextInfo.surveyAnswers.isEmpty()) {
                                Text(
                                    text = "  " + stringResource(R.string.common_none),
                                    fontSize = 12.sp,
                                    fontFamily = FontFamily.Monospace,
                                    color = Color.Gray
                                )
                            } else {
                                contextInfo.surveyAnswers.forEach { (key, value) ->
                                    Text(
                                        text = "  $key = $value",
                                        fontSize = 12.sp,
                                        fontFamily = FontFamily.Monospace
                                    )
                                }
                            }

                            Spacer(modifier = Modifier.height(8.dp))
                            Text(
                                text = stringResource(R.string.lab_debug_rapid_test_results),
                                fontWeight = FontWeight.SemiBold,
                                fontSize = 14.sp
                            )
                            if (contextInfo.rapidTestResults.isEmpty()) {
                                Text(
                                    text = "  " + stringResource(R.string.common_none),
                                    fontSize = 12.sp,
                                    fontFamily = FontFamily.Monospace,
                                    color = Color.Gray
                                )
                            } else {
                                contextInfo.rapidTestResults.forEach { (key, value) ->
                                    Text(
                                        text = "  $key = \"$value\"",
                                        fontSize = 12.sp,
                                        fontFamily = FontFamily.Monospace
                                    )
                                }
                            }

                            Spacer(modifier = Modifier.height(12.dp))
                            HorizontalDivider(color = Color(0xFFFFCC80))
                            Spacer(modifier = Modifier.height(12.dp))

                            // Lab Test Evaluations
                            Text(
                                text = stringResource(R.string.lab_debug_lab_test_evaluations),
                                fontWeight = FontWeight.SemiBold,
                                fontSize = 14.sp
                            )
                            Spacer(modifier = Modifier.height(4.dp))

                            debugInfo!!.second.forEach { result ->
                                Card(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 4.dp),
                                    colors = CardDefaults.cardColors(
                                        containerColor = if (result.shouldShow) Color(0xFFC8E6C9) else Color(0xFFFFCDD2)
                                    )
                                ) {
                                    Column(modifier = Modifier.padding(8.dp)) {
                                        Text(
                                            text = result.labTest.testName,
                                            fontWeight = FontWeight.Medium,
                                            fontSize = 14.sp
                                        )
                                        Text(
                                            text = stringResource(R.string.lab_debug_condition, result.jexlCondition ?: stringResource(R.string.lab_debug_none)),
                                            fontSize = 11.sp,
                                            fontFamily = FontFamily.Monospace
                                        )
                                        Text(
                                            text = stringResource(R.string.lab_debug_result, result.evaluationResult ?: stringResource(R.string.lab_debug_na), if (result.shouldShow) stringResource(R.string.lab_debug_show) else stringResource(R.string.lab_debug_hide)),
                                            fontSize = 11.sp,
                                            fontFamily = FontFamily.Monospace,
                                            fontWeight = FontWeight.Bold,
                                            color = if (result.shouldShow) Color(0xFF2E7D32) else Color(0xFFC62828)
                                        )
                                    }
                                }
                            }
                        }
                    }
                }

                // Instructions section. Each step gets its own well so the
                // staff member can't blur them together — especially step 2,
                // which renders the literal subject ID in a large monospace
                // badge so the operator never has to look back at the Subject
                // ID card to figure out what to write on the tube.
                Text(
                    text = stringResource(R.string.lab_instructions),
                    fontWeight = FontWeight.Bold,
                    fontSize = 26.sp,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(top = 8.dp, bottom = 4.dp)
                )

                StepWell(number = 1, text = stringResource(R.string.lab_step_1))

                // Step 2 — extended well that pairs the label with a giant
                // ID badge below it.
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.secondaryContainer
                    ),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(20.dp),
                        verticalAlignment = Alignment.Top
                    ) {
                        StepNumberBadge(2)
                        Spacer(modifier = Modifier.width(16.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = stringResource(R.string.lab_step_2_label),
                                fontSize = 22.sp,
                                fontWeight = FontWeight.Medium,
                                lineHeight = 30.sp,
                                color = MaterialTheme.colorScheme.onSecondaryContainer
                            )
                            Spacer(modifier = Modifier.height(12.dp))
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(8.dp))
                                    .border(2.dp, MaterialTheme.colorScheme.primary, RoundedCornerShape(8.dp))
                                    .padding(vertical = 20.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = subjectId,
                                    fontSize = 40.sp,
                                    fontWeight = FontWeight.Bold,
                                    fontFamily = FontFamily.Monospace,
                                    color = MaterialTheme.colorScheme.primary,
                                    letterSpacing = 3.sp
                                )
                            }
                        }
                    }
                }

                StepWell(number = 3, text = stringResource(R.string.lab_step_3))
                StepWell(number = 4, text = stringResource(R.string.lab_step_4))

                // Action Buttons
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    OutlinedButton(
                        onClick = onCancel,
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.outlinedButtonColors(
                            contentColor = Color(0xFFD32F2F)
                        ),
                        border = BorderStroke(1.dp, Color(0xFFD32F2F))
                    ) {
                        Text(stringResource(R.string.lab_refused))
                    }

                    Button(
                        onClick = onSamplesCollected,
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = Color(0xFF1976D2)
                        )
                    ) {
                        Text(stringResource(R.string.lab_collected))
                    }
                }

            }
        }
    }
}

@Composable
private fun StepNumberBadge(number: Int) {
    Box(
        modifier = Modifier
            .size(44.dp)
            .background(MaterialTheme.colorScheme.primary, RoundedCornerShape(22.dp)),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = number.toString(),
            color = MaterialTheme.colorScheme.onPrimary,
            fontWeight = FontWeight.Bold,
            fontSize = 22.sp
        )
    }
}

@Composable
private fun StepWell(number: Int, text: String) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.secondaryContainer
        ),
        shape = RoundedCornerShape(12.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(20.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            StepNumberBadge(number)
            Spacer(modifier = Modifier.width(16.dp))
            Text(
                text = text,
                fontSize = 22.sp,
                fontWeight = FontWeight.Medium,
                lineHeight = 30.sp,
                color = MaterialTheme.colorScheme.onSecondaryContainer,
                modifier = Modifier.weight(1f)
            )
        }
    }
}
