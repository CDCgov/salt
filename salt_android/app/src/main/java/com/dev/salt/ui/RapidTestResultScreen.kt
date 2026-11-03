package com.dev.salt.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Science
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dev.salt.logging.AppLogger as Log
import androidx.compose.ui.res.stringResource
import com.dev.salt.R
import com.dev.salt.data.SurveyDatabase
import com.dev.salt.data.TestResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.activity.compose.BackHandler

@Composable
fun RapidTestResultScreen(
    surveyId: String,
    testId: String,
    testName: String,
    onResultSubmitted: () -> Unit,
    onBack: () -> Unit
) {
    // Disable hardware back button during survey flow
    BackHandler(enabled = true) {
        // Intentionally empty - back button is disabled during survey flow
    }

    val context = LocalContext.current
    val database = remember { SurveyDatabase.getInstance(context) }
    val coroutineScope = rememberCoroutineScope()

    var selectedResult by remember { mutableStateOf<String?>(null) }
    var isProcessing by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    // Load existing result if any
    LaunchedEffect(surveyId, testId) {
        withContext(Dispatchers.IO) {
            val existingResult = database.testResultDao().getTestResult(surveyId, testId)
            existingResult?.let {
                selectedResult = it.result
            }
        }
    }

    // Note: These values are stored in database, display labels need stringResource which requires @Composable
    val testResultOptions = listOf(
        "negative",
        "positive",
        "indeterminate",
        "not_performed"
    )

    val handleSubmit = {
        if (selectedResult != null) {
            coroutineScope.launch {
                isProcessing = true
                errorMessage = null

                try {
                    withContext(Dispatchers.IO) {
                        // Save test result to database
                        val testResult = TestResult(
                            surveyId = surveyId,
                            testId = testId,
                            testName = testName,
                            result = selectedResult!!,
                            recordedAt = System.currentTimeMillis()
                        )
                        database.testResultDao().insertTestResult(testResult)
                        Log.d("RapidTestResult", "Saved test result for $testName")
                    }

                    onResultSubmitted()
                } catch (e: Exception) {
                    Log.e("RapidTestResult", "Error saving test result", e)
                    errorMessage = context.getString(R.string.test_result_save_error, e.message)
                    isProcessing = false
                }
            }
        }
    }

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 32.dp),
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surface
                )
            ) {
                Column(
                    modifier = Modifier.padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    // Icon
                    Icon(
                        Icons.Filled.Science,
                        contentDescription = stringResource(R.string.cd_test_icon, testName),
                        modifier = Modifier
                            .size(64.dp)
                            .padding(bottom = 16.dp),
                        tint = MaterialTheme.colorScheme.primary
                    )

                    // Title
                    Text(
                        text = stringResource(R.string.test_title_format, testName),
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(bottom = 8.dp)
                    )

                    // Instructions
                    Text(
                        text = stringResource(R.string.test_instruction_format, testName),
                        style = MaterialTheme.typography.bodyLarge,
                        textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(bottom = 24.dp)
                    )

                    // Result options
                    Column(
                        modifier = Modifier.fillMaxWidth(),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        testResultOptions.forEach { value ->
                            val label = when (value) {
                                "negative" -> stringResource(R.string.test_result_negative)
                                "positive" -> stringResource(R.string.test_result_positive)
                                "indeterminate" -> stringResource(R.string.test_result_indeterminate)
                                "not_performed" -> stringResource(R.string.test_result_not_performed)
                                else -> value
                            }
                            Card(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .selectable(
                                        selected = (selectedResult == value),
                                        onClick = { selectedResult = value },
                                        role = Role.RadioButton
                                    ),
                                shape = RoundedCornerShape(12.dp),
                                colors = CardDefaults.cardColors(
                                    containerColor = if (selectedResult == value) {
                                        MaterialTheme.colorScheme.primaryContainer
                                    } else {
                                        MaterialTheme.colorScheme.surfaceVariant
                                    }
                                )
                            ) {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(16.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    RadioButton(
                                        selected = (selectedResult == value),
                                        onClick = { selectedResult = value }
                                    )
                                    Spacer(modifier = Modifier.width(12.dp))
                                    Column {
                                        Text(
                                            text = label,
                                            style = MaterialTheme.typography.titleMedium,
                                            fontWeight = if (selectedResult == value) FontWeight.Bold else FontWeight.Normal
                                        )
                                        if (value == "indeterminate") {
                                            Text(
                                                text = stringResource(R.string.test_indeterminate_description),
                                                style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant
                                            )
                                        } else if (value == "not_performed") {
                                            Text(
                                                text = stringResource(R.string.test_not_performed_description),
                                                style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Error message
                    errorMessage?.let { error ->
                        Text(
                            text = error,
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodyMedium,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.padding(top = 16.dp)
                        )
                    }

                    // Submit button
                    Button(
                        onClick = { handleSubmit() },
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 24.dp)
                            .height(56.dp),
                        enabled = selectedResult != null && !isProcessing,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.primary
                        )
                    ) {
                        if (isProcessing) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(24.dp),
                                color = MaterialTheme.colorScheme.onPrimary
                            )
                        } else {
                            Text(
                                text = stringResource(R.string.test_submit_result),
                                style = MaterialTheme.typography.labelLarge
                            )
                        }
                    }

                    // Back button
                    OutlinedButton(
                        onClick = onBack,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 8.dp),
                        enabled = !isProcessing
                    ) {
                        Text(stringResource(R.string.common_back))
                    }
                }
            }
        }
    }
}
