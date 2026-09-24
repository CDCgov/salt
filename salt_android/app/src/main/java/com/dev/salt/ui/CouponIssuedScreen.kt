package com.dev.salt.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import android.media.MediaPlayer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.*
import com.dev.salt.playAudio
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import com.dev.salt.ui.components.MarkdownText
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.dev.salt.AppDestinations
import com.dev.salt.logging.AppLogger as Log
import androidx.compose.ui.res.stringResource
import com.dev.salt.R
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.activity.compose.BackHandler

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CouponIssuedScreen(
    navController: NavController,
    generatedCoupons: List<String>,
    surveyId: String? = null,
    database: com.dev.salt.data.SurveyDatabase? = null
) {
    // Disable hardware back button during survey flow
    BackHandler(enabled = true) {
        // Intentionally empty - back button is disabled during survey flow
    }

    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val actualDatabase = database ?: com.dev.salt.data.SurveyDatabase.getInstance(context)

    // State for actual coupons - use parameter if available, otherwise load from database
    var actualCoupons by remember { mutableStateOf(generatedCoupons) }

    // Load coupons from database if parameter is empty
    LaunchedEffect(surveyId, generatedCoupons) {
        Log.d("CouponIssuedScreen", "=== COUPON ISSUED SCREEN LOADED ===")
        Log.d("CouponIssuedScreen", "surveyId: $surveyId")
        Log.d("CouponIssuedScreen", "generatedCoupons parameter: $generatedCoupons")

        if (generatedCoupons.isEmpty() && !surveyId.isNullOrBlank()) {
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                val dbCoupons = actualDatabase.couponDao().getCouponsIssuedToSurvey(surveyId)
                Log.d("CouponIssuedScreen", "Loading from database - found ${dbCoupons.size} coupons: ${dbCoupons.map { it.couponCode }}")
                if (dbCoupons.isNotEmpty()) {
                    actualCoupons = dbCoupons.map { it.couponCode }
                }
            }
        } else {
            actualCoupons = generatedCoupons
        }
    }

    // Tracks whether the staff has shown the participant the coupon
    // instructions modal at least once. Continue button is disabled until
    // they do so, so the participant always gets the explainer.
    var instructionsShown by remember { mutableStateOf(false) }
    var showInstructionsModal by remember { mutableStateOf(false) }
    var instructionsMessage by remember { mutableStateOf<String?>(null) }
    var instructionsAudioPath by remember { mutableStateOf<String?>(null) }
    var mediaPlayer by remember { mutableStateOf<MediaPlayer?>(null) }

    // Load the coupon_instructions system message + audio when the modal is
    // first opened. We keep it loaded so reopening doesn't re-fetch.
    LaunchedEffect(showInstructionsModal) {
        if (!showInstructionsModal || instructionsMessage != null) return@LaunchedEffect
        try {
            val key = "coupon_instructions"
            val survey = withContext(Dispatchers.IO) {
                if (!surveyId.isNullOrBlank()) actualDatabase.surveyDao().getSurveyById(surveyId) else null
            }
            val lang = survey?.language ?: "en"
            val msg = withContext(Dispatchers.IO) {
                actualDatabase.systemMessageDao().getSystemMessage(key, lang)
                    ?: actualDatabase.systemMessageDao().getSystemMessage(key, "en")
                    ?: actualDatabase.systemMessageDao().getSystemMessage(key, "English")
                    ?: actualDatabase.systemMessageDao().getSystemMessageAnyLanguage(key)
            }
            instructionsMessage = msg?.messageText?.takeIf { it.isNotBlank() }
            instructionsAudioPath = msg?.audioFileName?.takeIf { it.isNotBlank() }
            Log.d("CouponIssuedScreen", "coupon_instructions loaded: hasText=${instructionsMessage != null} hasAudio=${instructionsAudioPath != null}")
        } catch (e: Exception) {
            Log.e("CouponIssuedScreen", "Failed to load coupon_instructions message", e)
        }
    }

    // Start/stop audio with the modal visibility. audioFileName from
    // SystemMessage is just a basename (saved by SurveySyncManager into
    // context.filesDir/audio/); the playAudio helper resolves that path and
    // sets the right audio attributes — calling MediaPlayer.setDataSource()
    // on the basename directly throws ENOENT.
    LaunchedEffect(showInstructionsModal, instructionsAudioPath) {
        if (showInstructionsModal && !instructionsAudioPath.isNullOrEmpty()) {
            try {
                mediaPlayer?.release()
                mediaPlayer = playAudio(context, instructionsAudioPath!!)?.also { it.start() }
            } catch (e: Exception) {
                Log.e("CouponIssuedScreen", "Failed to play coupon_instructions audio", e)
            }
        } else {
            try { mediaPlayer?.stop() } catch (_: Exception) {}
            mediaPlayer?.release()
            mediaPlayer = null
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            try { mediaPlayer?.stop() } catch (_: Exception) {}
            mediaPlayer?.release()
            mediaPlayer = null
        }
    }

    fun continueToNext() {
        if (surveyId.isNullOrBlank()) {
            Log.e("CouponIssuedScreen", "No survey ID provided")
            return
        }
        scope.launch {
            val surveyConfig = actualDatabase.surveyConfigDao().getSurveyConfig()
            val facilityConfig = actualDatabase.facilityConfigDao().getFacilityConfig()
            val survey = withContext(Dispatchers.IO) {
                actualDatabase.surveyDao().getSurveyById(surveyId)
            }

            val isWalkIn = survey?.referralCouponCode == null
            val isFingerprintDisabled = surveyConfig?.fingerprintEnabled == false
            val hasRecruitmentPayment = (facilityConfig?.recruitmentPaymentAmount ?: 0.0) > 0.0
            // With no coupons the participant can't recruit anyone, so the
            // recruitment-payment instructions don't apply — skip that screen.
            val hasCoupons = actualCoupons.isNotEmpty()
            val shouldShowWalkInInstructions = isWalkIn && isFingerprintDisabled && hasRecruitmentPayment && hasCoupons

            if (shouldShowWalkInInstructions) {
                navController.navigate("${AppDestinations.WALKIN_RECRUITMENT_PAYMENT}/$surveyId")
            } else {
                val isHivTestEnabled = surveyConfig?.hivRapidTestEnabled == true
                if (isHivTestEnabled) {
                    navController.navigate("${AppDestinations.HIV_TEST_RESULT}/$surveyId")
                } else {
                    navController.navigate("${AppDestinations.SUBJECT_PAYMENT}/$surveyId?coupons=${actualCoupons.joinToString(",")}")
                }
            }
        }
    }

    Scaffold(
        topBar = {
            SaltTopAppBar(
                title = stringResource(R.string.coupon_issued_referral_title),
                navController = navController,
                showBackButton = true,
                showHomeButton = true
            )
        }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(horizontal = 24.dp)
                .verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(20.dp)
        ) {
            Spacer(modifier = Modifier.height(8.dp))

            if (actualCoupons.isEmpty()) {
                // 0-coupon variant (e.g. seed participants, facilities issuing
                // no coupons). Just acknowledge there's nothing to hand out and
                // let the staff continue.
                Text(
                    text = stringResource(R.string.coupon_screen_no_coupons),
                    style = MaterialTheme.typography.titleMedium,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(vertical = 32.dp)
                )

                Button(
                    onClick = { continueToNext() },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp)
                ) {
                    Text(
                        text = stringResource(R.string.coupon_issued_continue_payment),
                        style = MaterialTheme.typography.titleMedium
                    )
                }
            } else {
                // Staff instruction list — each step in its own well. Step 2
                // is custom: under its label we render the coupon codes grid
                // ("the codes below" is literal — they're inside the same
                // well), so the staff doesn't have to scan elsewhere to find
                // what they're writing.
                Text(
                    text = stringResource(R.string.coupon_screen_section_title),
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 4.dp, bottom = 4.dp)
                )

                Column(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    CouponInstructionStep(1, stringResource(R.string.coupon_screen_step_1, actualCoupons.size))

                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.secondaryContainer
                        ),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(16.dp)
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                StepBadge(2)
                                Spacer(modifier = Modifier.width(14.dp))
                                Text(
                                    text = stringResource(R.string.coupon_screen_step_2),
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Medium,
                                    color = MaterialTheme.colorScheme.onSecondaryContainer,
                                    modifier = Modifier.weight(1f)
                                )
                            }
                            Spacer(modifier = Modifier.height(16.dp))
                            CouponCodeGrid(actualCoupons)
                        }
                    }

                    CouponInstructionStep(3, stringResource(R.string.coupon_screen_step_3))
                    CouponInstructionStep(4, stringResource(R.string.coupon_screen_step_4))
                }

                // Coupon Instructions button — primary action while pending.
                Button(
                    onClick = {
                        instructionsShown = true
                        showInstructionsModal = true
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp)
                ) {
                    Text(
                        text = stringResource(R.string.coupon_screen_instructions_button),
                        style = MaterialTheme.typography.titleMedium
                    )
                }

                // Continue button — gated on instructions having been shown.
                Button(
                    onClick = { continueToNext() },
                    enabled = instructionsShown,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp)
                ) {
                    Text(
                        text = stringResource(R.string.coupon_issued_continue_payment),
                        style = MaterialTheme.typography.titleMedium
                    )
                }
                if (!instructionsShown) {
                    Text(
                        text = stringResource(R.string.coupon_screen_continue_disabled_hint),
                        style = MaterialTheme.typography.bodySmall,
                        textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            Spacer(modifier = Modifier.height(16.dp))
        }
    }

    if (showInstructionsModal) {
        AlertDialog(
            onDismissRequest = { showInstructionsModal = false },
            title = {
                Text(text = stringResource(R.string.coupon_screen_instructions_modal_title))
            },
            text = {
                MarkdownText(
                    markdown = instructionsMessage
                        ?: stringResource(R.string.coupon_screen_instructions_fallback),
                    baseStyle = MaterialTheme.typography.bodyLarge
                )
            },
            confirmButton = {
                TextButton(onClick = { showInstructionsModal = false }) {
                    Text(stringResource(R.string.coupon_screen_instructions_done))
                }
            }
        )
    }
}

@Composable
private fun CouponInstructionStep(number: Int, text: String) {
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
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            StepBadge(number)
            Spacer(modifier = Modifier.width(14.dp))
            Text(
                text = text,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSecondaryContainer,
                modifier = Modifier.weight(1f)
            )
        }
    }
}

@Composable
private fun StepBadge(number: Int) {
    Box(
        modifier = Modifier
            .size(40.dp)
            .background(MaterialTheme.colorScheme.primary, RoundedCornerShape(20.dp)),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = number.toString(),
            color = MaterialTheme.colorScheme.onPrimary,
            fontWeight = FontWeight.Bold,
            fontSize = 20.sp
        )
    }
}

/**
 * Coupon code list. Single column when there are <= 3 codes, two columns when
 * there are more (so a 5- or 6-coupon facility doesn't push the buttons off
 * the bottom of the screen).
 */
@Composable
private fun CouponCodeGrid(codes: List<String>) {
    val twoColumns = codes.size > 3
    val rows: List<List<String>> = if (twoColumns) codes.chunked(2) else codes.map { listOf(it) }
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        rows.forEachIndexed { rowIndex, rowCodes ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                rowCodes.forEachIndexed { colIndex, code ->
                    val flatIndex = if (twoColumns) rowIndex * 2 + colIndex else rowIndex
                    CouponCodeCell(
                        number = flatIndex + 1,
                        code = code,
                        modifier = Modifier.weight(1f)
                    )
                }
                // If this is the last row of an odd count in 2-col mode, pad
                // the empty slot so the lone code doesn't stretch full-width.
                if (twoColumns && rowCodes.size == 1) {
                    Spacer(modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun CouponCodeCell(number: Int, code: String, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            text = stringResource(R.string.coupon_issued_number, number),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSecondaryContainer.copy(alpha = 0.7f),
            modifier = Modifier.padding(bottom = 4.dp)
        )
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(8.dp))
                .border(2.dp, MaterialTheme.colorScheme.primary, RoundedCornerShape(8.dp))
                .padding(16.dp),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = code,
                style = MaterialTheme.typography.headlineMedium.copy(
                    fontFamily = FontFamily.Monospace,
                    letterSpacing = 4.sp
                ),
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary
            )
        }
    }
}