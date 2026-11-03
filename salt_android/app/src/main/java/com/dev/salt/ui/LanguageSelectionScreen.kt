package com.dev.salt.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.dev.salt.AppDestinations
import com.dev.salt.data.SurveyDatabase
import kotlinx.coroutines.launch
import androidx.compose.ui.res.stringResource
import com.dev.salt.R
import androidx.activity.compose.BackHandler

data class LanguageOption(
    val code: String
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LanguageSelectionScreen(
    navController: NavController,
    surveyId: String,
    couponCode: String?
) {
    // Disable hardware back button during survey flow
    BackHandler(enabled = true) {
        // Intentionally empty - back button is disabled during survey flow
    }

    val context = androidx.compose.ui.platform.LocalContext.current
    val database = remember { SurveyDatabase.getInstance(context) }
    val scope = rememberCoroutineScope()
    
    var availableLanguages by remember { mutableStateOf<List<LanguageOption>>(emptyList()) }
    var selectedLanguage by remember { mutableStateOf<LanguageOption?>(null) }
    var isLoading by remember { mutableStateOf(true) }
    
    // Load available languages from database
    LaunchedEffect(Unit) {
        scope.launch {
            try {
                // Query distinct languages from questions table
                val languages = database.surveyDao().getDistinctLanguages()
                com.dev.salt.logging.AppLogger.d("LanguageSelection", "Available languages in DB: $languages")
                
                // Create language options directly from database
                availableLanguages = languages.map { langCode ->
                    LanguageOption(langCode)
                }.sortedBy { it.code }
                
                // Default to first available language
                selectedLanguage = availableLanguages.firstOrNull()
                com.dev.salt.logging.AppLogger.d("LanguageSelection", "Selected default language: ${selectedLanguage?.code}")
                    
                isLoading = false
            } catch (e: Exception) {
                com.dev.salt.logging.AppLogger.e("LanguageSelection", "Error loading languages", e)
                // Default to English if there's an error
                availableLanguages = listOf(LanguageOption("English"))
                selectedLanguage = availableLanguages.first()
                isLoading = false
            }
        }
    }
    
    Scaffold(
        topBar = {
            SaltTopAppBar(
                title = stringResource(R.string.language_selection_title),
                navController = navController,
                showBackButton = false,
                showHomeButton = true
            )
        }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                text = stringResource(R.string.language_selection_prompt),
                style = MaterialTheme.typography.headlineSmall,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(bottom = 24.dp)
            )
            
            if (isLoading) {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center
                ) {
                    CircularProgressIndicator()
                }
            } else {
                // Language options
                LazyColumn(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    items(availableLanguages) { language ->
                        Card(
                            onClick = { selectedLanguage = language },
                            modifier = Modifier.fillMaxWidth(),
                            colors = if (selectedLanguage == language) {
                                CardDefaults.cardColors(
                                    containerColor = MaterialTheme.colorScheme.primaryContainer
                                )
                            } else {
                                CardDefaults.cardColors()
                            }
                        ) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(16.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = language.code,
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Medium
                                )
                                
                                if (selectedLanguage == language) {
                                    RadioButton(
                                        selected = true,
                                        onClick = null
                                    )
                                }
                            }
                        }
                    }
                }
                
                Spacer(modifier = Modifier.height(16.dp))
                
                // Continue button
                Button(
                    onClick = {
                        selectedLanguage?.let { lang ->
                            scope.launch {
                                try {
                                    // Update the survey with the selected language
                                    val survey = database.surveyDao().getSurveyById(surveyId)
                                    com.dev.salt.logging.AppLogger.d("LanguageSelection", "Updating survey $surveyId from language '${survey?.language}' to '${lang.code}'")
                                    if (survey != null) {
                                        val updatedSurvey = survey.copy(language = lang.code)
                                        database.surveyDao().updateSurvey(updatedSurvey)
                                        com.dev.salt.logging.AppLogger.d("LanguageSelection", "Survey language updated successfully")
                                    } else {
                                        com.dev.salt.logging.AppLogger.e("LanguageSelection", "Survey $surveyId not found in database!")
                                    }

                                    // Check if staff eligibility screening is enabled
                                    val surveyConfig = database.surveyConfigDao().getSurveyConfig()
                                    val staffEligibilityScreening = surveyConfig?.staffEligibilityScreening ?: false
                                    com.dev.salt.logging.AppLogger.d("LanguageSelection", "Staff eligibility screening: $staffEligibilityScreening")

                                    if (staffEligibilityScreening) {
                                        // Staff screening mode: skip consent, go to survey start
                                        // Consent will be collected after eligibility is confirmed
                                        com.dev.salt.logging.AppLogger.d("LanguageSelection", "Staff screening enabled - skipping consent, going to survey start")
                                        navController.navigate("${AppDestinations.SURVEY_START_INSTRUCTION}?surveyId=$surveyId&couponCode=$couponCode") {
                                            popUpTo(AppDestinations.LANGUAGE_SELECTION) { inclusive = true }
                                        }
                                    } else {
                                        // Self-screening mode: consent first (current behavior)
                                        com.dev.salt.logging.AppLogger.d("LanguageSelection", "Self-screening mode - going to consent first")
                                        navController.navigate("${AppDestinations.CONSENT_INSTRUCTION}/$surveyId?coupons=$couponCode") {
                                            popUpTo(AppDestinations.LANGUAGE_SELECTION) { inclusive = true }
                                        }
                                    }
                                } catch (e: Exception) {
                                    com.dev.salt.logging.AppLogger.e("LanguageSelection", "Error starting survey", e)
                                }
                            }
                        }
                    },
                    enabled = selectedLanguage != null,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp)
                ) {
                    Text(
                        text = stringResource(R.string.common_continue),
                        style = MaterialTheme.typography.titleMedium
                    )
                }
            }
        }
    }
}