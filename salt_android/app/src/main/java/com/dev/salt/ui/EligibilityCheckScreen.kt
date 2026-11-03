package com.dev.salt.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import com.dev.salt.ui.components.MarkdownText
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dev.salt.logging.AppLogger as Log
import android.media.MediaPlayer
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import com.dev.salt.PasswordUtils
import com.dev.salt.R
import com.dev.salt.data.SurveyDatabase
import com.dev.salt.fingerprint.IFingerprintCapture
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.activity.compose.BackHandler

@Composable
fun EligibilityCheckScreen(
    surveyId: String,
    isEligible: Boolean,  // This will always be false when this screen is shown
    onContinue: () -> Unit,  // Not used for ineligible participants
    onCancel: () -> Unit
) {
    // Disable hardware back button during survey flow
    BackHandler(enabled = true) {
        // Intentionally empty - back button is disabled during survey flow
    }

    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val database = remember { SurveyDatabase.getInstance(context) }

    var showPasswordDialog by remember { mutableStateOf(false) }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var attemptsRemaining by remember { mutableIntStateOf(10) }
    var isAuthenticating by remember { mutableStateOf(false) }
    var mediaPlayer by remember { mutableStateOf<MediaPlayer?>(null) }

    // Load the appropriate message based on eligibility
    var message by remember { mutableStateOf("") }
    var audioPath by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        scope.launch {
            try {
                // Get the survey's language
                val survey = database.surveyDao().getSurveyById(surveyId)
                val surveyLanguage = survey?.language ?: "en"

                Log.d("EligibilityCheck", "Survey ID: $surveyId, Language: $surveyLanguage")

                // Get the "not eligible" system message
                val messageKey = "eligibility_not_eligible"

                // Try to get the message in the survey's language
                var systemMessage = withContext(Dispatchers.IO) {
                    database.systemMessageDao().getSystemMessage(messageKey, surveyLanguage)
                }

                // Fallback to English if not found
                if (systemMessage == null) {
                    systemMessage = withContext(Dispatchers.IO) {
                        database.systemMessageDao().getSystemMessage(messageKey, "en")
                            ?: database.systemMessageDao().getSystemMessage(messageKey, "English")
                    }
                }

                // Use default message if still not found
                message = systemMessage?.messageText ?: ""

                // Set audio path if available
                audioPath = systemMessage?.audioFileName

                // Auto-play audio if available
                if (!audioPath.isNullOrEmpty()) {
                    try {
                        mediaPlayer?.release()
                        mediaPlayer = MediaPlayer().apply {
                            setDataSource(audioPath)
                            prepare()
                            start()
                        }
                        Log.d("EligibilityCheck", "Playing audio: $audioPath")
                    } catch (e: Exception) {
                        Log.e("EligibilityCheck", "Error playing audio", e)
                    }
                }
            } catch (e: Exception) {
                Log.e("EligibilityCheck", "Error loading message", e)
                message = ""
            }
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            mediaPlayer?.release()
            mediaPlayer = null
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFFF5F5F5))
            .padding(16.dp),
        contentAlignment = Alignment.Center
    ) {
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 32.dp),
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = Color.White),
            elevation = CardDefaults.cardElevation(defaultElevation = 8.dp)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(24.dp)
            ) {
                // Title - No warning icon, more respectful tone
                Text(
                    text = stringResource(R.string.eligibility_title),
                    fontSize = 24.sp,
                    fontWeight = FontWeight.Bold,
                    color = Color(0xFF1976D2),
                    textAlign = TextAlign.Center
                )

                // Message (Markdown-formatted)
                MarkdownText(
                    markdown = message.ifEmpty { stringResource(R.string.eligibility_not_eligible_default) },
                    modifier = Modifier.padding(vertical = 16.dp),
                    baseStyle = TextStyle(fontSize = 18.sp, textAlign = TextAlign.Center),
                    color = Color.DarkGray
                )

                // Audio replay button if audio is available
                if (!audioPath.isNullOrEmpty()) {
                    OutlinedButton(
                        onClick = {
                            scope.launch {
                                try {
                                    mediaPlayer?.release()
                                    mediaPlayer = MediaPlayer().apply {
                                        setDataSource(audioPath)
                                        prepare()
                                        start()
                                    }
                                } catch (e: Exception) {
                                    Log.e("EligibilityCheck", "Error replaying audio", e)
                                }
                            }
                        },
                        modifier = Modifier.padding(top = 8.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Default.PlayArrow,
                            contentDescription = stringResource(R.string.cd_replay),
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(stringResource(R.string.eligibility_replay_audio), fontSize = 14.sp)
                    }
                }

                // Error message
                errorMessage?.let { error ->
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = Color(0xFFFFEBEE))
                    ) {
                        Text(
                            text = error,
                            color = Color(0xFFC62828),
                            modifier = Modifier.padding(12.dp),
                            fontSize = 14.sp,
                            textAlign = TextAlign.Center
                        )
                    }
                }

                // Attempts remaining
                if (attemptsRemaining < 10) {
                    Text(
                        text = stringResource(R.string.eligibility_attempts_remaining, attemptsRemaining),
                        fontSize = 14.sp,
                        color = if (attemptsRemaining <= 3) Color.Red else Color.Gray
                    )
                }

                Spacer(modifier = Modifier.height(8.dp))

                // Staff validation message
                Text(
                    text = stringResource(R.string.eligibility_hand_back),
                    fontSize = 16.sp,
                    color = Color.Gray,
                    textAlign = TextAlign.Center
                )

                // Authentication buttons
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    // Fingerprint button
                    Button(
                        onClick = {
                            scope.launch {
                                isAuthenticating = true
                                errorMessage = null

                                // Get all staff and admin users with fingerprint templates
                                val staffUsers = withContext(Dispatchers.IO) {
                                    database.userDao().getAllUsers()
                                        .filter { (it.role == "SURVEY_STAFF" || it.role == "ADMINISTRATOR") &&
                                                 it.fingerprintTemplate != null }
                                }

                                if (staffUsers.isEmpty()) {
                                    errorMessage = context.getString(R.string.error_no_fingerprints_enrolled)
                                    showPasswordDialog = true
                                    isAuthenticating = false
                                } else {
                                    Log.i("EligibilityCheck", "Starting fingerprint authentication")

                                    // Check for USB device and permission
                                    val usbManager = context.getSystemService(android.content.Context.USB_SERVICE) as UsbManager
                                    val deviceList = usbManager.deviceList
                                    var secugenDevice: UsbDevice? = null

                                    for ((_, device) in deviceList) {
                                        if (device.vendorId == 0x1162) { // SecuGen vendor ID
                                            secugenDevice = device
                                            break
                                        }
                                    }

                                    if (secugenDevice == null) {
                                        errorMessage = context.getString(R.string.error_fingerprint_scanner_not_connected)
                                        isAuthenticating = false
                                        return@launch
                                    }

                                    if (!usbManager.hasPermission(secugenDevice)) {
                                        Log.i("EligibilityCheck", "Requesting USB permission")
                                        val permissionIntent = PendingIntent.getBroadcast(
                                            context,
                                            0,
                                            Intent("com.dev.salt.USB_PERMISSION").apply {
                                                setPackage(context.packageName)
                                            },
                                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                                                PendingIntent.FLAG_IMMUTABLE
                                            } else {
                                                0
                                            }
                                        )
                                        usbManager.requestPermission(secugenDevice, permissionIntent)
                                        errorMessage = context.getString(R.string.error_fingerprint_usb_permission)
                                        isAuthenticating = false
                                        return@launch
                                    }

                                    // Create fingerprint implementation
                                    val fingerprintImpl: IFingerprintCapture = com.dev.salt.fingerprint.FingerprintImplFactory.create(context)

                                    // Initialize device
                                    if (!fingerprintImpl.initializeDevice()) {
                                        errorMessage = context.getString(R.string.error_fingerprint_init_failed)
                                        isAuthenticating = false
                                        return@launch
                                    }

                                    // Capture fingerprint
                                    val capturedTemplate = fingerprintImpl.captureFingerprint()

                                    if (capturedTemplate == null) {
                                        fingerprintImpl.closeDevice()
                                        errorMessage = context.getString(R.string.error_fingerprint_capture_failed)
                                        isAuthenticating = false
                                        attemptsRemaining--
                                        return@launch
                                    }

                                    // Try to match against all staff fingerprints
                                    var matchedUser: String? = null
                                    for (user in staffUsers) {
                                        if (user.fingerprintTemplate != null) {
                                            val matchResult = fingerprintImpl.matchTemplates(
                                                capturedTemplate,
                                                user.fingerprintTemplate
                                            )
                                            if (matchResult) {
                                                matchedUser = user.userName
                                                Log.i("EligibilityCheck", "Fingerprint matched for user: ${user.userName}")
                                                break
                                            }
                                        }
                                    }

                                    fingerprintImpl.closeDevice()
                                    isAuthenticating = false

                                    if (matchedUser != null) {
                                        Log.i("EligibilityCheck", "Staff member authenticated: $matchedUser")
                                        // Mark survey as completed and mark referral coupon as used (ineligible participant consumes coupon)
                                        withContext(Dispatchers.IO) {
                                            val survey = database.surveyDao().getSurveyById(surveyId)
                                            survey?.let { s ->
                                                database.surveyDao().updateSurvey(
                                                    s.copy(isCompleted = true)
                                                )
                                                // Mark referral coupon as used - ineligible participants consume their coupon
                                                s.referralCouponCode?.let { code ->
                                                    try {
                                                        database.couponDao().markCouponUsed(
                                                            code = code,
                                                            surveyId = s.id,
                                                            usedDate = System.currentTimeMillis()
                                                        )
                                                        Log.i("EligibilityCheck", "Marked coupon $code as used for ineligible participant in survey ${s.id}")
                                                    } catch (e: Exception) {
                                                        Log.e("EligibilityCheck", "Failed to mark coupon as used", e)
                                                    }
                                                }
                                            }
                                        }
                                        onCancel() // End the survey
                                    } else {
                                        attemptsRemaining--
                                        errorMessage = if (attemptsRemaining <= 0) {
                                            context.getString(R.string.error_fingerprint_max_attempts)
                                        } else {
                                            context.getString(R.string.error_fingerprint_not_recognized)
                                        }
                                    }
                                }
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                        enabled = attemptsRemaining > 0 && !isAuthenticating,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = Color(0xFF1976D2)
                        )
                    ) {
                        if (isAuthenticating) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(24.dp),
                                color = Color.White
                            )
                        } else {
                            Icon(
                                imageVector = Icons.Default.Fingerprint,
                                contentDescription = "Fingerprint",
                                modifier = Modifier.size(24.dp)
                            )
                        }
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            if (isAuthenticating) stringResource(R.string.eligibility_scanning) else stringResource(R.string.eligibility_fingerprint_button),
                            fontSize = 16.sp
                        )
                    }

                    // Password button
                    Button(
                        onClick = { showPasswordDialog = true },
                        modifier = Modifier.fillMaxWidth(),
                        enabled = attemptsRemaining > 0,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = Color(0xFF757575)
                        )
                    ) {
                        Icon(
                            imageVector = Icons.Default.Lock,
                            contentDescription = "Password",
                            modifier = Modifier.size(24.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(stringResource(R.string.eligibility_password_button), fontSize = 16.sp)
                    }
                }
            }
        }
    }

    // Password dialog
    if (showPasswordDialog) {
        AlertDialog(
            onDismissRequest = { showPasswordDialog = false },
            title = { Text(stringResource(R.string.staff_validation_login)) },
            text = {
                Column(
                    verticalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    OutlinedTextField(
                        value = username,
                        onValueChange = { username = it },
                        label = { Text(stringResource(R.string.label_username)) },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true
                    )

                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        label = { Text(stringResource(R.string.label_password)) },
                        modifier = Modifier.fillMaxWidth(),
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        singleLine = true
                    )

                    errorMessage?.let { error ->
                        Text(
                            text = error,
                            color = Color.Red,
                            fontSize = 14.sp
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        scope.launch {
                            errorMessage = null
                            // Validate against database users
                            val user = withContext(Dispatchers.IO) {
                                database.userDao().getUserByUserName(username)
                            }

                            if (user != null &&
                                (user.role == "SURVEY_STAFF" || user.role == "ADMINISTRATOR") &&
                                PasswordUtils.verifyPassword(password, user.hashedPassword)) {
                                showPasswordDialog = false
                                // Mark survey as completed and mark referral coupon as used (ineligible participant consumes coupon)
                                withContext(Dispatchers.IO) {
                                    val survey = database.surveyDao().getSurveyById(surveyId)
                                    survey?.let { s ->
                                        database.surveyDao().updateSurvey(
                                            s.copy(isCompleted = true)
                                        )
                                        // Mark referral coupon as used - ineligible participants consume their coupon
                                        s.referralCouponCode?.let { code ->
                                            try {
                                                database.couponDao().markCouponUsed(
                                                    code = code,
                                                    surveyId = s.id,
                                                    usedDate = System.currentTimeMillis()
                                                )
                                                Log.i("EligibilityCheck", "Marked coupon $code as used for ineligible participant in survey ${s.id}")
                                            } catch (e: Exception) {
                                                Log.e("EligibilityCheck", "Failed to mark coupon as used", e)
                                            }
                                        }
                                    }
                                }
                                onCancel() // End the survey
                            } else {
                                attemptsRemaining--
                                if (attemptsRemaining <= 0) {
                                    errorMessage = context.getString(R.string.error_fingerprint_max_attempts)
                                    showPasswordDialog = false
                                } else {
                                    errorMessage = context.getString(R.string.error_invalid_credentials)
                                }
                                password = ""
                            }
                        }
                    },
                    enabled = username.isNotBlank() && password.isNotBlank() && attemptsRemaining > 0
                ) {
                    Text(stringResource(R.string.common_login))
                }
            },
            dismissButton = {
                TextButton(onClick = { showPasswordDialog = false }) {
                    Text(stringResource(R.string.common_cancel))
                }
            }
        )
    }
}