package com.dev.salt.ui

import android.media.MediaPlayer
import com.dev.salt.logging.AppLogger as Log
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AttachMoney
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material3.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.dev.salt.AppDestinations
import com.dev.salt.data.SurveyDatabase
import com.dev.salt.ui.components.MarkdownText
import com.dev.salt.playAudio
import com.dev.salt.fingerprint.IFingerprintCapture
import com.dev.salt.fingerprint.SecuGenFingerprintImpl
import com.dev.salt.fingerprint.MockFingerprintImpl
import com.dev.salt.util.EmulatorDetector
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.dev.salt.upload.SurveyUploadManager
import com.dev.salt.upload.SurveyUploadWorkManager
import com.dev.salt.upload.UploadResult
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.ui.res.stringResource
import com.dev.salt.R
import androidx.activity.compose.BackHandler

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SubjectPaymentScreen(
    navController: NavController,
    surveyId: String,
    coupons: String
) {
    // Disable hardware back button during survey flow
    BackHandler(enabled = true) {
        // Intentionally empty - back button is disabled during survey flow
    }

    val context = LocalContext.current
    val database = remember { SurveyDatabase.getInstance(context) }
    val scope = rememberCoroutineScope()

    var facilityConfig by remember { mutableStateOf<com.dev.salt.data.FacilityConfig?>(null) }
    var survey by remember { mutableStateOf<com.dev.salt.data.Survey?>(null) }
    var paymentAmount by remember { mutableStateOf(0.0) }
    var fingerprintEnabled by remember { mutableStateOf(true) }
    var isCapturingFingerprint by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var currentMediaPlayer by remember { mutableStateOf<MediaPlayer?>(null) }
    var isUploading by remember { mutableStateOf(false) }
    var uploadMessage by remember { mutableStateOf<String?>(null) }
    var paymentMessage by remember { mutableStateOf("") }
    var messageMediaPlayer by remember { mutableStateOf<MediaPlayer?>(null) }
    var showAdminOverrideDialog by remember { mutableStateOf(false) }
    var isCapturingAdminFingerprint by remember { mutableStateOf(false) }
    var adminOverrideError by remember { mutableStateOf<String?>(null) }
    var adminOverrideSuccess by remember { mutableStateOf(false) }
    var paymentAuditPhoneEnabled by remember { mutableStateOf(false) }
    var paymentPhone by remember { mutableStateOf("") }
    var phoneError by remember { mutableStateOf<String?>(null) }

    // Get default payment message and error strings
    val defaultPaymentMessage = stringResource(R.string.payment_default_message)
    val errorNoFingerprint = stringResource(R.string.payment_error_no_fingerprint)
    val errorScannerNotConnected = stringResource(R.string.payment_error_scanner_not_connected)
    val errorUsbPermission = stringResource(R.string.payment_error_usb_permission)
    val errorFingerprintMismatch = stringResource(R.string.payment_error_fingerprint_mismatch)

    // Phone strings
    val phoneLabel = stringResource(R.string.payment_phone_label)
    val phonePlaceholder = stringResource(R.string.payment_phone_placeholder)
    val phoneRequiredError = stringResource(R.string.payment_phone_required)
    val phoneAuditNote = stringResource(R.string.payment_phone_audit_note)

    // Admin override strings
    val adminOverrideButton = stringResource(R.string.payment_admin_override_button)
    val adminOverrideTitle = stringResource(R.string.payment_admin_override_title)
    val adminOverrideMessage = stringResource(R.string.payment_admin_override_message)
    val adminOverrideScanning = stringResource(R.string.payment_admin_override_scanning)
    val adminOverrideScanButton = stringResource(R.string.payment_admin_override_scan_button)
    val adminOverrideNoMatch = stringResource(R.string.payment_admin_override_error_no_match)

    // Load facility config and survey
    LaunchedEffect(Unit) {
        facilityConfig = database.facilityConfigDao().getFacilityConfig()
        survey = database.surveyDao().getSurveyById(surveyId)

        // Load fingerprint setting and payment audit phone setting from survey config
        val surveyConfig = database.surveyConfigDao().getSurveyConfig()
        fingerprintEnabled = surveyConfig?.fingerprintEnabled ?: false
        paymentAuditPhoneEnabled = surveyConfig?.paymentAuditPhoneEnabled ?: false

        // Calculate payment amount
        facilityConfig?.let { config ->
            if (config.subjectPaymentType != "None") {
                paymentAmount = config.participationPaymentAmount
            }
        }

        Log.d("SubjectPaymentScreen", "Payment config: type=${facilityConfig?.subjectPaymentType}, amount=$paymentAmount, fingerprintEnabled=$fingerprintEnabled")

        // Load payment confirmation message from database
        scope.launch {
            val lang = survey?.language ?: "en"
            val systemMessage = database.systemMessageDao().getSystemMessage("payment_confirmation", lang)
                ?: database.systemMessageDao().getSystemMessage("payment_confirmation", "English")
                ?: database.systemMessageDao().getSystemMessageAnyLanguage("payment_confirmation")

            if (systemMessage != null) {
                paymentMessage = systemMessage.messageText
                Log.d("SubjectPaymentScreen", "Loaded payment message: ${systemMessage.messageText}")

                // Play audio if available
                if (!systemMessage.audioFileName.isNullOrEmpty()) {
                    Log.d("SubjectPaymentScreen", "Playing payment audio: ${systemMessage.audioFileName}")
                    try {
                        messageMediaPlayer = playAudio(context, systemMessage.audioFileName)
                    } catch (e: Exception) {
                        Log.e("SubjectPaymentScreen", "Error playing message audio", e)
                    }
                }
            } else {
                Log.d("SubjectPaymentScreen", "No payment_confirmation message found, using default")
                paymentMessage = defaultPaymentMessage
            }
        }
    }

    // Play audio instruction if available
    LaunchedEffect(survey?.language) {
        survey?.let { s ->
            // TODO: Get payment audio file based on language from survey config
            // For now, using placeholder
            val audioFileName = when (s.language) {
                "es" -> "payment_instruction_es.mp3"
                else -> "payment_instruction_en.mp3"
            }

            try {
                currentMediaPlayer?.stop()
                currentMediaPlayer?.release()
                currentMediaPlayer = playAudio(context, audioFileName)
            } catch (e: Exception) {
                Log.e("SubjectPaymentScreen", "Error playing audio", e)
            }
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            currentMediaPlayer?.stop()
            currentMediaPlayer?.release()
            messageMediaPlayer?.let { player ->
                try {
                    if (player.isPlaying) {
                        player.stop()
                    }
                    player.release()
                    Log.d("SubjectPaymentScreen", "Message MediaPlayer released")
                } catch (e: Exception) {
                    Log.e("SubjectPaymentScreen", "Error releasing message MediaPlayer", e)
                }
            }
        }
    }

    Scaffold(
        topBar = {
            SaltTopAppBar(
                title = stringResource(R.string.payment_title),
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
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(24.dp)
        ) {
            // Payment icon
            Icon(
                imageVector = Icons.Default.AttachMoney,
                contentDescription = stringResource(R.string.cd_payment),
                modifier = Modifier.size(80.dp),
                tint = MaterialTheme.colorScheme.primary
            )

            // Thank you message (Markdown-formatted)
            MarkdownText(
                markdown = paymentMessage,
                baseStyle = MaterialTheme.typography.headlineSmall.copy(
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center
                ),
                color = MaterialTheme.colorScheme.primary
            )

            // Audio replay button (only show if audio is available)
            if (messageMediaPlayer != null) {
                OutlinedButton(
                    onClick = {
                        try {
                            messageMediaPlayer?.let { player ->
                                if (!player.isPlaying) {
                                    player.seekTo(0)
                                    player.start()
                                    Log.d("SubjectPaymentScreen", "Replaying payment audio")
                                }
                            }
                        } catch (e: Exception) {
                            Log.e("SubjectPaymentScreen", "Error replaying audio", e)
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
                    Text(stringResource(R.string.payment_replay_audio), fontSize = 14.sp)
                }
            }

            // Payment amount card
            if (paymentAmount > 0) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.primaryContainer
                    ),
                    elevation = CardDefaults.cardElevation(defaultElevation = 4.dp)
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Text(
                            text = getPaymentAmountLabel(survey?.language ?: "en"),
                            style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.7f)
                        )

                        Text(
                            text = "${facilityConfig?.paymentCurrencySymbol ?: "$"}${String.format("%.2f", paymentAmount)}",
                            style = MaterialTheme.typography.displayMedium,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary
                        )

                        Text(
                            text = facilityConfig?.paymentCurrency ?: "USD",
                            style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.7f)
                        )
                    }
                }
            }

            // Phone input for payment audit (only when enabled and payment amount > 0)
            if (paymentAuditPhoneEnabled && paymentAmount > 0) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant
                    )
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        OutlinedTextField(
                            value = paymentPhone,
                            onValueChange = { newValue ->
                                paymentPhone = newValue.filter { it.isDigit() }
                                phoneError = null
                            },
                            label = { Text("$phoneLabel *") },
                            placeholder = { Text(phonePlaceholder) },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            isError = phoneError != null,
                            leadingIcon = {
                                Icon(
                                    imageVector = Icons.Default.Phone,
                                    contentDescription = null,
                                    tint = if (phoneError != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
                                )
                            },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true
                        )
                        if (phoneError != null) {
                            Text(
                                text = phoneError!!,
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                        Text(
                            text = phoneAuditNote,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)
                        )
                    }
                }
            }

            // Instructions
            if (fingerprintEnabled) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = Color(0xFFFFF3CD)
                    )
                ) {
                    Row(
                        modifier = Modifier.padding(16.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Default.Fingerprint,
                            contentDescription = null,
                            tint = Color(0xFF856404),
                            modifier = Modifier.size(24.dp)
                        )
                        Text(
                            text = getConfirmationInstruction(survey?.language ?: "en"),
                            color = Color(0xFF856404),
                            style = MaterialTheme.typography.bodyMedium
                        )
                    }
                }
            }

            // Upload message
            uploadMessage?.let { message ->
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = if (message.contains("success", true))
                            Color(0xFF4CAF50).copy(alpha = 0.1f)
                        else
                            MaterialTheme.colorScheme.primaryContainer
                    )
                ) {
                    Text(
                        text = message,
                        color = if (message.contains("success", true))
                            Color(0xFF2E7D32)
                        else
                            MaterialTheme.colorScheme.onPrimaryContainer,
                        modifier = Modifier.padding(16.dp),
                        textAlign = TextAlign.Center
                    )
                }
            }

            // Error message
            errorMessage?.let { message ->
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer
                    )
                ) {
                    Text(
                        text = message,
                        color = MaterialTheme.colorScheme.onErrorContainer,
                        modifier = Modifier.padding(16.dp),
                        textAlign = TextAlign.Center
                    )
                }
            }

            Spacer(modifier = Modifier.weight(1f))

            // Get error and upload messages outside onClick lambda
            val deviceInitError = stringResource(R.string.fingerprint_device_init_failed)
            val captureFailedError = stringResource(R.string.fingerprint_capture_failed)
            val uploadingMsg = stringResource(R.string.payment_uploading)
            val uploadSuccessMsg = stringResource(R.string.payment_upload_success)
            val uploadFailedMsg = stringResource(R.string.payment_upload_failed)
            val uploadErrorMsg = stringResource(R.string.payment_upload_error)

            // Show different buttons based on fingerprint setting
            if (fingerprintEnabled) {
                // Fingerprint enabled: Show fingerprint verification button
                Button(
                onClick = {
                    scope.launch {
                        // Validate phone if required
                        if (paymentAuditPhoneEnabled && paymentAmount > 0 && paymentPhone.isBlank()) {
                            phoneError = phoneRequiredError
                            return@launch
                        }

                        isCapturingFingerprint = true
                        errorMessage = null

                        // Get the subject's previously enrolled fingerprint
                        val subjectFingerprint = withContext(Dispatchers.IO) {
                            database.subjectFingerprintDao().getFingerprintBySurveyId(surveyId)
                        }

                        if (subjectFingerprint == null) {
                            Log.e("SubjectPaymentScreen", "No fingerprint found for survey $surveyId")
                            errorMessage = errorNoFingerprint
                            isCapturingFingerprint = false
                            return@launch
                        }

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
                            errorMessage = errorScannerNotConnected
                            isCapturingFingerprint = false
                            return@launch
                        }

                        if (!usbManager.hasPermission(secugenDevice)) {
                            Log.i("SubjectPaymentScreen", "Requesting USB permission")
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
                            errorMessage = errorUsbPermission
                            isCapturingFingerprint = false
                            return@launch
                        }

                        // Create fingerprint implementation
                        val fingerprintImpl: IFingerprintCapture = if (EmulatorDetector.isEmulator()) {
                            Log.i("SubjectPaymentScreen", "Using mock fingerprint implementation for emulator")
                            MockFingerprintImpl()
                        } else {
                            try {
                                Log.i("SubjectPaymentScreen", "Using SecuGen fingerprint implementation")
                                SecuGenFingerprintImpl(context)
                            } catch (e: Exception) {
                                Log.e("SubjectPaymentScreen", "Failed to create SecuGen implementation, using mock", e)
                                MockFingerprintImpl()
                            }
                        }

                        // Initialize fingerprint device
                        if (!fingerprintImpl.initializeDevice()) {
                            errorMessage = deviceInitError
                            isCapturingFingerprint = false
                            return@launch
                        }

                        // Capture fingerprint
                        val capturedTemplate = fingerprintImpl.captureFingerprint()

                        if (capturedTemplate == null) {
                            errorMessage = captureFailedError
                            isCapturingFingerprint = false
                            fingerprintImpl.closeDevice()
                            return@launch
                        }

                        // Match against the subject's original fingerprint
                        val isMatch = fingerprintImpl.matchTemplates(
                            capturedTemplate,
                            subjectFingerprint.fingerprintTemplate
                        )

                        fingerprintImpl.closeDevice()

                        if (!isMatch) {
                            errorMessage = errorFingerprintMismatch
                            isCapturingFingerprint = false
                            Log.w("SubjectPaymentScreen", "Fingerprint mismatch for survey $surveyId")
                            return@launch
                        }

                        Log.i("SubjectPaymentScreen", "Fingerprint verified successfully for survey $surveyId")

                        // Update survey with payment confirmation
                        survey?.let { s ->
                            val updatedSurvey = s.copy(
                                paymentConfirmed = true,
                                paymentAmount = paymentAmount,
                                paymentType = facilityConfig?.subjectPaymentType ?: "Cash",
                                paymentDate = System.currentTimeMillis(),
                                paymentPhoneNumber = if (paymentAuditPhoneEnabled && paymentAmount > 0) paymentPhone else null,
                                isCompleted = true
                            )
                            database.surveyDao().updateSurvey(updatedSurvey)
                            database.couponDao().markCouponsAsIssued(surveyId)
                            Log.i("SubjectPaymentScreen", "Payment confirmed for survey $surveyId: amount=$paymentAmount, phone recorded=${!updatedSurvey.paymentPhoneNumber.isNullOrBlank()}")

                            // Mark referral coupon as used ONLY after payment confirmed
                            s.referralCouponCode?.let { code ->
                                try {
                                    database.couponDao().markCouponUsed(
                                        code = code,
                                        surveyId = s.id,
                                        usedDate = System.currentTimeMillis()
                                    )
                                    Log.i("SubjectPaymentScreen", "Marked coupon $code as used after payment confirmed for survey ${s.id}")
                                } catch (e: Exception) {
                                    Log.e("SubjectPaymentScreen", "Failed to mark coupon as used", e)
                                }
                            }
                        }

                        isCapturingFingerprint = false

                        // Upload survey after payment confirmation
                        isUploading = true
                        uploadMessage = uploadingMsg
                        try {
                            Log.i("SubjectPaymentScreen", "Starting upload for survey: $surveyId")
                            val uploadManager = SurveyUploadManager(context, database)
                            val uploadResult = uploadManager.uploadSurvey(surveyId)

                            when (uploadResult) {
                                is UploadResult.Success -> {
                                    Log.i("SubjectPaymentScreen", "Survey uploaded successfully: $surveyId")
                                    uploadMessage = uploadSuccessMsg
                                }
                                else -> {
                                    Log.e("SubjectPaymentScreen", "Upload failed: $uploadResult")
                                    uploadMessage = uploadFailedMsg
                                    // Schedule retry if failed
                                    val uploadWorkManager = SurveyUploadWorkManager(context)
                                    uploadWorkManager.scheduleImmediateRetry(surveyId)
                                }
                            }
                        } catch (e: Exception) {
                            Log.e("SubjectPaymentScreen", "Error uploading survey", e)
                            uploadMessage = uploadErrorMsg
                        } finally {
                            isUploading = false
                            // Navigate to menu after a short delay to show the message
                            delay(1500)
                            navController.navigate(AppDestinations.MENU) {
                                popUpTo(AppDestinations.MENU) { inclusive = false }
                            }
                        }
                    }
                },
                enabled = !isCapturingFingerprint && !isUploading,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.primary
                )
            ) {
                if (isCapturingFingerprint || isUploading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp),
                        color = MaterialTheme.colorScheme.onPrimary
                    )
                } else {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            imageVector = Icons.Default.Fingerprint,
                            contentDescription = null
                        )
                        Text(
                            text = stringResource(R.string.payment_confirm_received),
                            style = MaterialTheme.typography.titleMedium
                        )
                    }
                }
            }

                // Admin Override button - only shown when payment type is configured (not "None")
                // Allows admin to confirm payment received without subject fingerprint
                if (facilityConfig?.subjectPaymentType != "None" && !adminOverrideSuccess) {
                    OutlinedButton(
                        onClick = {
                            showAdminOverrideDialog = true
                            adminOverrideError = null
                        },
                        enabled = !isCapturingFingerprint && !isUploading && !isCapturingAdminFingerprint,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(56.dp)
                    ) {
                        Text(
                            text = adminOverrideButton,
                            style = MaterialTheme.typography.titleSmall
                        )
                    }
                }
            } else {
                // Fingerprint disabled: Show simple Continue button (no fingerprint capture)
                Button(
                    onClick = {
                        scope.launch {
                            // Validate phone if required
                            if (paymentAuditPhoneEnabled && paymentAmount > 0 && paymentPhone.isBlank()) {
                                phoneError = phoneRequiredError
                                return@launch
                            }

                            // Update survey with payment confirmation (no fingerprint)
                            survey?.let { s ->
                                val updatedSurvey = s.copy(
                                    paymentConfirmed = true,
                                    paymentAmount = paymentAmount,
                                    paymentType = facilityConfig?.subjectPaymentType ?: "Cash",
                                    paymentDate = System.currentTimeMillis(),
                                    paymentPhoneNumber = if (paymentAuditPhoneEnabled && paymentAmount > 0) paymentPhone else null,
                                    isCompleted = true
                                )
                                database.surveyDao().updateSurvey(updatedSurvey)
                                database.couponDao().markCouponsAsIssued(surveyId)
                                Log.i("SubjectPaymentScreen", "Payment confirmed (no fingerprint) for survey $surveyId: amount=$paymentAmount, phone recorded=${!updatedSurvey.paymentPhoneNumber.isNullOrBlank()}")

                                // Mark referral coupon as used ONLY after payment confirmed
                                s.referralCouponCode?.let { code ->
                                    try {
                                        database.couponDao().markCouponUsed(
                                            code = code,
                                            surveyId = s.id,
                                            usedDate = System.currentTimeMillis()
                                        )
                                        Log.i("SubjectPaymentScreen", "Marked coupon $code as used after payment confirmed for survey ${s.id}")
                                    } catch (e: Exception) {
                                        Log.e("SubjectPaymentScreen", "Failed to mark coupon as used", e)
                                    }
                                }
                            }

                            // Upload survey after payment confirmation
                            isUploading = true
                            uploadMessage = uploadingMsg
                            try {
                                Log.i("SubjectPaymentScreen", "Starting upload for survey: $surveyId")
                                val uploadManager = SurveyUploadManager(context, database)
                                val uploadResult = uploadManager.uploadSurvey(surveyId)

                                when (uploadResult) {
                                    is UploadResult.Success -> {
                                        Log.i("SubjectPaymentScreen", "Survey uploaded successfully: $surveyId")
                                        uploadMessage = uploadSuccessMsg
                                    }
                                    else -> {
                                        Log.e("SubjectPaymentScreen", "Upload failed: $uploadResult")
                                        uploadMessage = uploadFailedMsg
                                        // Schedule retry if failed
                                        val uploadWorkManager = SurveyUploadWorkManager(context)
                                        uploadWorkManager.scheduleImmediateRetry(surveyId)
                                    }
                                }
                            } catch (e: Exception) {
                                Log.e("SubjectPaymentScreen", "Error uploading survey", e)
                                uploadMessage = uploadErrorMsg
                            } finally {
                                isUploading = false
                                // Navigate to menu after a short delay to show the message
                                delay(1500)
                                navController.navigate(AppDestinations.MENU) {
                                    popUpTo(AppDestinations.MENU) { inclusive = false }
                                }
                            }
                        }
                    },
                    enabled = !isUploading,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary
                    )
                ) {
                    if (isUploading) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(24.dp),
                            color = MaterialTheme.colorScheme.onPrimary
                        )
                    } else {
                        Text(
                            text = "Continue",
                            style = MaterialTheme.typography.titleMedium
                        )
                    }
                }
            }

            // Skip button if payment is None
            if (facilityConfig?.subjectPaymentType == "None") {
                // Get upload messages outside onClick lambda
                val skipUploadingMsg = stringResource(R.string.payment_uploading)
                val skipUploadSuccessMsg = stringResource(R.string.payment_upload_success)
                val skipUploadFailedMsg = stringResource(R.string.payment_upload_failed)
                val skipUploadErrorMsg = stringResource(R.string.payment_upload_error)

                OutlinedButton(
                    onClick = {
                        scope.launch {
                            // Mark survey as completed without payment (payment type = None)
                            val updatedSurvey = survey?.copy(
                                isCompleted = true,
                                paymentConfirmed = true, // Confirmed eligible even though no payment given
                                paymentDate = System.currentTimeMillis(),
                                paymentType = "None"
                            )
                            if (updatedSurvey != null) {
                                database.surveyDao().updateSurvey(updatedSurvey)
                                database.couponDao().markCouponsAsIssued(surveyId)
                                Log.i("SubjectPaymentScreen", "Survey marked complete (no payment) for survey $surveyId")
                            }

                            // Upload survey
                            isUploading = true
                            uploadMessage = skipUploadingMsg
                            try {
                                Log.i("SubjectPaymentScreen", "Starting upload for survey: $surveyId")
                                val uploadManager = SurveyUploadManager(context, database)
                                val uploadResult = uploadManager.uploadSurvey(surveyId)

                                when (uploadResult) {
                                    is UploadResult.Success -> {
                                        Log.i("SubjectPaymentScreen", "Survey uploaded successfully: $surveyId")
                                        uploadMessage = skipUploadSuccessMsg
                                    }
                                    else -> {
                                        Log.e("SubjectPaymentScreen", "Upload failed: $uploadResult")
                                        uploadMessage = skipUploadFailedMsg
                                        // Schedule retry if failed
                                        val uploadWorkManager = SurveyUploadWorkManager(context)
                                        uploadWorkManager.scheduleImmediateRetry(surveyId)
                                    }
                                }
                            } catch (e: Exception) {
                                Log.e("SubjectPaymentScreen", "Error uploading survey", e)
                                uploadMessage = skipUploadErrorMsg
                            } finally {
                                isUploading = false
                                // Navigate to menu after a short delay to show the message
                                delay(1500)
                                navController.navigate(AppDestinations.MENU) {
                                    popUpTo(AppDestinations.MENU) { inclusive = false }
                                }
                            }
                        }
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp)
                ) {
                    Text(
                        text = stringResource(R.string.payment_continue_without),
                        style = MaterialTheme.typography.titleMedium
                    )
                }
            }
        }
    }

    // Admin Override Dialog
    if (showAdminOverrideDialog) {
        // Get messages outside onClick lambda
        val deviceInitError = stringResource(R.string.fingerprint_device_init_failed)
        val captureFailedError = stringResource(R.string.fingerprint_capture_failed)
        val uploadingMsg = stringResource(R.string.payment_uploading)
        val uploadSuccessMsg = stringResource(R.string.payment_upload_success)
        val uploadFailedMsg = stringResource(R.string.payment_upload_failed)
        val uploadErrorMsg = stringResource(R.string.payment_upload_error)

        AlertDialog(
            onDismissRequest = {
                if (!isCapturingAdminFingerprint) {
                    showAdminOverrideDialog = false
                    adminOverrideError = null
                }
            },
            title = { Text(adminOverrideTitle) },
            text = {
                Column(
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Text(
                        adminOverrideMessage,
                        style = MaterialTheme.typography.bodyMedium
                    )

                    if (isCapturingAdminFingerprint) {
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            CircularProgressIndicator(modifier = Modifier.size(20.dp))
                            Text(adminOverrideScanning)
                        }
                    }

                    adminOverrideError?.let { error ->
                        Card(
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.errorContainer
                            )
                        ) {
                            Text(
                                text = error,
                                color = MaterialTheme.colorScheme.onErrorContainer,
                                modifier = Modifier.padding(12.dp)
                            )
                        }
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        scope.launch {
                            isCapturingAdminFingerprint = true
                            adminOverrideError = null

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
                                adminOverrideError = errorScannerNotConnected
                                isCapturingAdminFingerprint = false
                                return@launch
                            }

                            if (!usbManager.hasPermission(secugenDevice)) {
                                Log.i("SubjectPaymentScreen", "Requesting USB permission for admin override")
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
                                adminOverrideError = errorUsbPermission
                                isCapturingAdminFingerprint = false
                                return@launch
                            }

                            // Create fingerprint implementation
                            val fingerprintImpl: IFingerprintCapture = if (EmulatorDetector.isEmulator()) {
                                Log.i("SubjectPaymentScreen", "Using mock fingerprint for admin override")
                                MockFingerprintImpl()
                            } else {
                                try {
                                    SecuGenFingerprintImpl(context)
                                } catch (e: Exception) {
                                    Log.e("SubjectPaymentScreen", "Failed to create SecuGen impl, using mock", e)
                                    MockFingerprintImpl()
                                }
                            }

                            // Initialize fingerprint device
                            if (!fingerprintImpl.initializeDevice()) {
                                adminOverrideError = deviceInitError
                                isCapturingAdminFingerprint = false
                                return@launch
                            }

                            // Capture admin fingerprint
                            val capturedTemplate = fingerprintImpl.captureFingerprint()

                            if (capturedTemplate == null) {
                                adminOverrideError = captureFailedError
                                isCapturingAdminFingerprint = false
                                fingerprintImpl.closeDevice()
                                return@launch
                            }

                            // Get all admin users with enrolled fingerprints
                            val adminUsers = withContext(Dispatchers.IO) {
                                database.userDao().getUsersByRole("ADMINISTRATOR")
                            }

                            // Try to match against any admin's fingerprint
                            var matchedAdmin: com.dev.salt.data.User? = null
                            for (admin in adminUsers) {
                                if (admin.fingerprintTemplate != null) {
                                    val isMatch = fingerprintImpl.matchTemplates(
                                        capturedTemplate,
                                        admin.fingerprintTemplate
                                    )
                                    if (isMatch) {
                                        matchedAdmin = admin
                                        break
                                    }
                                }
                            }

                            fingerprintImpl.closeDevice()

                            if (matchedAdmin == null) {
                                adminOverrideError = adminOverrideNoMatch
                                isCapturingAdminFingerprint = false
                                Log.w("SubjectPaymentScreen", "No admin fingerprint match found")
                                return@launch
                            }

                            Log.i("SubjectPaymentScreen", "Admin ${matchedAdmin.fullName} authorized payment override for survey $surveyId")

                            // Update survey with payment confirmation and admin override info
                            survey?.let { s ->
                                val updatedSurvey = s.copy(
                                    paymentConfirmed = true,
                                    paymentAmount = paymentAmount,
                                    paymentType = "${facilityConfig?.subjectPaymentType ?: "Cash"} (Admin Override: ${matchedAdmin.fullName})",
                                    paymentDate = System.currentTimeMillis(),
                                    paymentPhoneNumber = if (paymentAuditPhoneEnabled && paymentAmount > 0) paymentPhone else null,
                                    isCompleted = true
                                )
                                database.surveyDao().updateSurvey(updatedSurvey)
                                database.couponDao().markCouponsAsIssued(surveyId)
                                Log.i("SubjectPaymentScreen", "Payment override confirmed by admin ${matchedAdmin.fullName}: amount=$paymentAmount, phone recorded=${!updatedSurvey.paymentPhoneNumber.isNullOrBlank()}")

                                // Mark referral coupon as used ONLY after payment confirmed (admin override)
                                s.referralCouponCode?.let { code ->
                                    try {
                                        database.couponDao().markCouponUsed(
                                            code = code,
                                            surveyId = s.id,
                                            usedDate = System.currentTimeMillis()
                                        )
                                        Log.i("SubjectPaymentScreen", "Marked coupon $code as used after admin override payment for survey ${s.id}")
                                    } catch (e: Exception) {
                                        Log.e("SubjectPaymentScreen", "Failed to mark coupon as used", e)
                                    }
                                }
                            }

                            isCapturingAdminFingerprint = false
                            showAdminOverrideDialog = false
                            adminOverrideSuccess = true
                            uploadMessage = context.getString(R.string.payment_admin_override_success, matchedAdmin.fullName)

                            // Upload survey after admin override
                            isUploading = true
                            delay(2000) // Show override message
                            uploadMessage = uploadingMsg
                            try {
                                Log.i("SubjectPaymentScreen", "Starting upload after admin override: $surveyId")
                                val uploadManager = SurveyUploadManager(context, database)
                                val uploadResult = uploadManager.uploadSurvey(surveyId)

                                when (uploadResult) {
                                    is UploadResult.Success -> {
                                        Log.i("SubjectPaymentScreen", "Survey uploaded successfully: $surveyId")
                                        uploadMessage = uploadSuccessMsg
                                    }
                                    else -> {
                                        Log.e("SubjectPaymentScreen", "Upload failed: $uploadResult")
                                        uploadMessage = uploadFailedMsg
                                        val uploadWorkManager = SurveyUploadWorkManager(context)
                                        uploadWorkManager.scheduleImmediateRetry(surveyId)
                                    }
                                }
                            } catch (e: Exception) {
                                Log.e("SubjectPaymentScreen", "Error uploading survey", e)
                                uploadMessage = uploadErrorMsg
                            } finally {
                                isUploading = false
                                delay(1500)
                                navController.navigate(AppDestinations.MENU) {
                                    popUpTo(AppDestinations.MENU) { inclusive = false }
                                }
                            }
                        }
                    },
                    enabled = !isCapturingAdminFingerprint
                ) {
                    Text(adminOverrideScanButton)
                }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        showAdminOverrideDialog = false
                        adminOverrideError = null
                    },
                    enabled = !isCapturingAdminFingerprint
                ) {
                    Text("Cancel")
                }
            }
        )
    }
}


private fun getPaymentAmountLabel(language: String): String {
    return when (language) {
        "es" -> "Monto del Pago"
        "fr" -> "Montant du Paiement"
        else -> "Payment Amount"
    }
}

private fun getConfirmationInstruction(language: String): String {
    return when (language) {
        "es" -> "Por favor confirme que ha recibido el pago usando su huella digital"
        "fr" -> "Veuillez confirmer que vous avez reçu le paiement en utilisant votre empreinte digitale"
        else -> "Please confirm that you have received the payment using your fingerprint"
    }
}
