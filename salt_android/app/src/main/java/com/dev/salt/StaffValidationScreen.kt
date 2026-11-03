package com.dev.salt

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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import com.dev.salt.ui.components.MarkdownText
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dev.salt.auth.BiometricAuthManager
import com.dev.salt.auth.BiometricAuthManagerFactory
import com.dev.salt.logging.AppLogger as Log
import com.dev.salt.auth.BiometricResult
import com.dev.salt.data.SurveyDatabase
import kotlinx.coroutines.launch
import androidx.compose.runtime.LaunchedEffect
import android.media.MediaPlayer
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.res.stringResource
import com.dev.salt.fingerprint.IFingerprintCapture
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.activity.compose.BackHandler

@Composable
fun StaffValidationScreen(
    surveyId: String,
    onValidationSuccess: () -> Unit,
    onCancel: () -> Unit,
    // True where Cancel leaves the survey while a participant may hold the
    // tablet: a staff member must authenticate before cancelling.
    requireStaffAuthToCancel: Boolean = false
) {
    var showCancelAuth by remember { mutableStateOf(false) }
    if (showCancelAuth) {
        com.dev.salt.ui.StaffAuthDialog(
            title = stringResource(R.string.leave_survey_auth_title),
            message = stringResource(R.string.leave_survey_auth_message),
            onAuthenticated = {
                showCancelAuth = false
                onCancel()
            },
            onDismiss = { showCancelAuth = false }
        )
    }

    // Disable hardware back button during survey flow
    BackHandler(enabled = true) {
        // Intentionally empty - back button is disabled during survey flow
    }

    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val database = remember { SurveyDatabase.getInstance(context) }
    val biometricAuthManager = remember {
        BiometricAuthManagerFactory.create(context, database.userDao())
    }

    var showPasswordDialog by remember { mutableStateOf(false) }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var attemptsRemaining by remember { mutableIntStateOf(10) }
    var isAuthenticating by remember { mutableStateOf(false) }
    var authenticatedUser by remember { mutableStateOf<String?>(null) }

    // Load staff validation message from database
    var validationMessage by remember { mutableStateOf("") }
    var mediaPlayer by remember { mutableStateOf<MediaPlayer?>(null) }

    LaunchedEffect(Unit) {
        scope.launch {
            // Get the survey's actual language
            val survey = database.surveyDao().getSurveyById(surveyId)
            val surveyLanguage = survey?.language ?: "en"

            Log.d("StaffValidation", "Survey ID: $surveyId, Language: $surveyLanguage")

            // Debug: Show all available staff_validation messages in the database
            val allStaffMessages = database.systemMessageDao().getAllMessagesForKey("staff_validation")
            Log.d("StaffValidation", "All staff_validation messages in DB: ${allStaffMessages.size} messages")
            allStaffMessages.forEach { msg ->
                Log.d("StaffValidation", "  - Language: '${msg.language}', Text: '${msg.messageText.take(50)}...'")
            }

            // Try to get the message in the survey's language, then fallback to English, then any language
            val systemMessage = database.systemMessageDao().getSystemMessage("staff_validation", surveyLanguage)
                ?: database.systemMessageDao().getSystemMessage("staff_validation", "en")
                ?: database.systemMessageDao().getSystemMessage("staff_validation", "English")
                ?: database.systemMessageDao().getSystemMessageAnyLanguage("staff_validation")

            if (systemMessage != null) {
                validationMessage = systemMessage.messageText
                Log.d("StaffValidation", "Loaded message in language '${systemMessage.language}': ${systemMessage.messageText}")

                // Play audio if available
                if (!systemMessage.audioFileName.isNullOrEmpty()) {
                    Log.d("StaffValidation", "Playing audio: ${systemMessage.audioFileName}")
                    mediaPlayer = playAudio(context, systemMessage.audioFileName)
                }
            } else {
                Log.d("StaffValidation", "No system message found for staff_validation, using default")
            }
        }
    }

    // Clean up MediaPlayer when the screen is disposed
    DisposableEffect(Unit) {
        onDispose {
            mediaPlayer?.let { player ->
                try {
                    if (player.isPlaying) {
                        player.stop()
                    }
                    player.release()
                    Log.d("StaffValidation", "MediaPlayer released")
                } catch (e: Exception) {
                    Log.e("StaffValidation", "Error releasing MediaPlayer", e)
                }
            }
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
                // Title
                Text(
                    text = stringResource(R.string.staff_validation_required),
                    fontSize = 24.sp,
                    fontWeight = FontWeight.Bold,
                    color = Color(0xFF1976D2),
                    textAlign = TextAlign.Center
                )

                // Message (Markdown-formatted)
                MarkdownText(
                    markdown = validationMessage.ifEmpty { stringResource(R.string.staff_validation_default) },
                    modifier = Modifier.padding(vertical = 16.dp),
                    baseStyle = TextStyle(fontSize = 18.sp, textAlign = TextAlign.Center),
                    color = Color.DarkGray
                )

                // Audio replay button (only show if audio is available)
                if (mediaPlayer != null) {
                    OutlinedButton(
                        onClick = {
                            try {
                                mediaPlayer?.let { player ->
                                    if (!player.isPlaying) {
                                        player.seekTo(0)
                                        player.start()
                                        Log.d("StaffValidation", "Replaying audio")
                                    }
                                }
                            } catch (e: Exception) {
                                Log.e("StaffValidation", "Error replaying audio", e)
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
                        Text(stringResource(R.string.staff_validation_replay_audio), fontSize = 14.sp)
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
                        text = stringResource(R.string.staff_validation_attempts_remaining, attemptsRemaining),
                        fontSize = 14.sp,
                        color = if (attemptsRemaining <= 3) Color.Red else Color.Gray
                    )
                }

                // Buttons
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
                                    Log.i("StaffValidation", "Starting fingerprint authentication")

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
                                        Log.i("StaffValidation", "Requesting USB permission")
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
                                                Log.i("StaffValidation", "Fingerprint matched for user: ${user.userName}")
                                                break
                                            }
                                        }
                                    }

                                    fingerprintImpl.closeDevice()
                                    isAuthenticating = false

                                    if (matchedUser != null) {
                                        authenticatedUser = matchedUser
                                        Log.i("StaffValidation", "Staff member authenticated: $matchedUser")
                                        onValidationSuccess()
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
                                imageVector = androidx.compose.material.icons.Icons.Default.Fingerprint,
                                contentDescription = "Fingerprint",
                                modifier = Modifier.size(24.dp)
                            )
                        }
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            if (isAuthenticating) stringResource(R.string.eligibility_scanning) else stringResource(R.string.staff_validation_authenticate_fingerprint),
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
                            imageVector = androidx.compose.material.icons.Icons.Default.Lock,
                            contentDescription = "Password",
                            modifier = Modifier.size(24.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(stringResource(R.string.staff_validation_use_password), fontSize = 16.sp)
                    }

                    // Cancel button
                    OutlinedButton(
                        onClick = { if (requireStaffAuthToCancel) showCancelAuth = true else onCancel() },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(stringResource(R.string.staff_validation_cancel), fontSize = 16.sp)
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
                        label = { Text(stringResource(R.string.staff_validation_username)) },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true
                    )

                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        label = { Text(stringResource(R.string.staff_validation_password)) },
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
                            val user = database.userDao().getUserByUserName(username)

                            if (user != null &&
                                (user.role == "SURVEY_STAFF" || user.role == "ADMINISTRATOR") &&
                                PasswordUtils.verifyPassword(password, user.hashedPassword)) {
                                showPasswordDialog = false
                                onValidationSuccess()
                            } else {
                                attemptsRemaining--
                                if (attemptsRemaining <= 0) {
                                    errorMessage = context.getString(R.string.staff_validation_max_attempts)
                                    showPasswordDialog = false
                                } else {
                                    errorMessage = context.getString(R.string.staff_validation_invalid_credentials)
                                }
                                password = ""
                            }
                        }
                    },
                    enabled = username.isNotBlank() && password.isNotBlank() && attemptsRemaining > 0
                ) {
                    Text(stringResource(R.string.staff_validation_login_button))
                }
            },
            dismissButton = {
                TextButton(onClick = { showPasswordDialog = false }) {
                    Text(stringResource(R.string.staff_validation_cancel))
                }
            }
        )
    }
}