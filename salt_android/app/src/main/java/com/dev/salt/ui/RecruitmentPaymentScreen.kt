package com.dev.salt.ui

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import com.dev.salt.logging.AppLogger as Log
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AttachMoney
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material3.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.dev.salt.AppDestinations
import com.dev.salt.R
import com.dev.salt.data.Coupon
import com.dev.salt.data.FacilityConfig
import com.dev.salt.data.Survey
import com.dev.salt.data.SurveyDatabase
import com.dev.salt.fingerprint.FingerprintManager
import com.dev.salt.fingerprint.IFingerprintCapture
import com.dev.salt.data.RecruitmentPaymentUploadState
import com.dev.salt.upload.RecruitmentPaymentUploadManager
import io.github.joelkanyi.sain.Sain
import io.github.joelkanyi.sain.SignatureAction
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.*
import androidx.activity.compose.BackHandler
import androidx.compose.ui.graphics.vector.ImageVector

// Helper data class for destructuring 4 values
data class Quadruple<A, B, C, D>(val first: A, val second: B, val third: C, val fourth: D)

// Enum for the 4 coupon states
enum class CouponDisplayState {
    NOT_USED,      // Coupon issued but not yet redeemed
    INELIGIBLE,    // Coupon used but recruit was ineligible
    PENDING,       // Coupon used by eligible recruit, awaiting payment
    PAID           // Recruitment payment already made
}

// Data class to hold coupon with its computed display state
data class CouponWithState(
    val coupon: Coupon,
    val displayState: CouponDisplayState
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecruitmentPaymentScreen(
    navController: NavController,
    surveyId: String,
    lookupMethod: String
) {
    // Disable hardware back button during survey flow
    BackHandler(enabled = true) {
        // Intentionally empty - back button is disabled during survey flow
    }

    val context = LocalContext.current
    val database = remember { SurveyDatabase.getInstance(context) }
    val fingerprintManager = remember { FingerprintManager(database.subjectFingerprintDao(), context) }
    val scope = rememberCoroutineScope()
    val scrollState = rememberScrollState()

    // State
    var survey by remember { mutableStateOf<Survey?>(null) }
    var facilityConfig by remember { mutableStateOf<FacilityConfig?>(null) }
    var allCoupons by remember { mutableStateOf<List<Coupon>>(emptyList()) }
    var couponsWithState by remember { mutableStateOf<List<CouponWithState>>(emptyList()) }
    var eligibleCoupons by remember { mutableStateOf<List<Coupon>>(emptyList()) }
    var isLoading by remember { mutableStateOf(true) }
    var isProcessing by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var successMessage by remember { mutableStateOf<String?>(null) }

    // Signature state (for coupon_admin_override path)
    var signatureBitmap by remember { mutableStateOf<ImageBitmap?>(null) }
    var signatureAction by remember { mutableStateOf<((SignatureAction) -> Unit)?>(null) }
    var hasDrawnSignature by remember { mutableStateOf(false) }

    // Fingerprint capture state (for fingerprint path)
    var isCapturingFingerprint by remember { mutableStateOf(false) }
    var showDeviceNotConnectedDialog by remember { mutableStateOf(false) }
    var showUsbPermissionDialog by remember { mutableStateOf(false) }

    // Phone input state for payment audit
    var paymentAuditPhoneEnabled by remember { mutableStateOf(false) }
    var paymentPhone by remember { mutableStateOf("") }
    var phoneError by remember { mutableStateOf<String?>(null) }

    // Error strings
    val deviceInitError = stringResource(R.string.fingerprint_device_init_failed)
    val captureFailedError = stringResource(R.string.fingerprint_capture_failed)
    val fingerprintMismatchError = stringResource(R.string.payment_error_fingerprint_mismatch)
    val scannerNotConnectedError = stringResource(R.string.payment_error_scanner_not_connected)
    val usbPermissionError = stringResource(R.string.payment_error_usb_permission)
    val paymentSuccessMsg = stringResource(R.string.recruitment_payment_success)
    val phoneLabel = stringResource(R.string.payment_phone_label)
    val phonePlaceholder = stringResource(R.string.payment_phone_placeholder)
    val phoneRequiredError = stringResource(R.string.payment_phone_required)
    val phoneAuditNote = stringResource(R.string.payment_phone_audit_note)

    // Date formatter
    val dateFormatter = remember { SimpleDateFormat("MMM dd, yyyy", Locale.getDefault()) }

    // Load data
    LaunchedEffect(surveyId) {
        withContext(Dispatchers.IO) {
            survey = database.surveyDao().getSurveyById(surveyId)
            facilityConfig = database.facilityConfigDao().getFacilityConfig()
            allCoupons = database.couponDao().getCouponsIssuedToSurvey(surveyId)

            // Compute the display state for each coupon
            val couponsWithStateList = allCoupons.map { coupon ->
                val displayState = when {
                    // State 1: Not Used - coupon not redeemed yet
                    coupon.status != "USED" -> CouponDisplayState.NOT_USED

                    // State 4: Already Paid
                    coupon.recruitmentPaymentDate != null -> CouponDisplayState.PAID

                    // For USED coupons without payment, check if recruit was eligible
                    else -> {
                        // Look up the recruit's survey to check eligibility
                        val recruitSurveyId = coupon.usedBySurveyId
                        if (recruitSurveyId != null) {
                            val recruitSurvey = database.surveyDao().getSurveyById(recruitSurveyId)
                            // If recruit's survey has paymentConfirmed = true, they were eligible
                            // If survey is completed but no payment confirmed, they were ineligible
                            when {
                                recruitSurvey == null -> CouponDisplayState.PENDING // Survey not found, assume pending
                                recruitSurvey.paymentConfirmed == true -> CouponDisplayState.PENDING // Eligible, awaiting recruitment payment
                                recruitSurvey.isCompleted -> CouponDisplayState.INELIGIBLE // Completed without payment = ineligible
                                else -> CouponDisplayState.PENDING // Still in progress, assume pending
                            }
                        } else {
                            CouponDisplayState.PENDING // No survey ID, assume pending
                        }
                    }
                }
                CouponWithState(coupon, displayState)
            }
            couponsWithState = couponsWithStateList

            // Filter eligible coupons: only those in PENDING state (used by eligible recruits, not yet paid)
            eligibleCoupons = couponsWithStateList
                .filter { it.displayState == CouponDisplayState.PENDING }
                .map { it.coupon }

            Log.d("RecruitmentPayment", "All coupons: ${allCoupons.size}, Eligible for payment: ${eligibleCoupons.size}")
            couponsWithStateList.forEach { cws ->
                Log.d("RecruitmentPayment", "Coupon ${cws.coupon.couponCode}: ${cws.displayState}")
            }

            // Load payment audit phone config
            val surveyConfig = database.surveyConfigDao().getSurveyConfig()
            paymentAuditPhoneEnabled = surveyConfig?.paymentAuditPhoneEnabled ?: false

            isLoading = false
        }
    }

    // Track signature changes
    LaunchedEffect(signatureBitmap) {
        hasDrawnSignature = signatureBitmap != null
        Log.d("RecruitmentPayment", "Signature bitmap updated: ${signatureBitmap != null}")
    }

    // Periodically check if signature has been drawn (same pattern as ConsentSignatureScreen)
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(500) // Check every 500ms
            signatureAction?.invoke(SignatureAction.COMPLETE)
        }
    }

    // Cleanup
    DisposableEffect(Unit) {
        onDispose {
            scope.launch {
                try {
                    fingerprintManager.closeDevice()
                } catch (e: Exception) {
                    Log.e("RecruitmentPayment", "Error closing fingerprint device", e)
                }
            }
        }
    }

    // Calculate payment
    val paymentAmount = (facilityConfig?.recruitmentPaymentAmount ?: 0.0) * eligibleCoupons.size
    val currencySymbol = facilityConfig?.paymentCurrencySymbol ?: "$"
    val currency = facilityConfig?.paymentCurrency ?: "USD"

    // Function to process payment
    fun processPayment(signature: String?, confirmationMethod: String) {
        scope.launch {
            // Validate phone if required
            if (paymentAuditPhoneEnabled && paymentPhone.isBlank()) {
                phoneError = phoneRequiredError
                return@launch
            }

            isProcessing = true
            errorMessage = null

            try {
                withContext(Dispatchers.IO) {
                    val currentTime = System.currentTimeMillis()
                    for (coupon in eligibleCoupons) {
                        database.couponDao().markRecruitmentPaymentMade(
                            code = coupon.couponCode,
                            paymentDate = currentTime,
                            signature = signature
                        )
                    }

                    // Create upload state and attempt upload
                    val paymentId = java.util.UUID.randomUUID().toString()
                    val uploadState = RecruitmentPaymentUploadState(
                        paymentId = paymentId,
                        surveyId = surveyId,
                        subjectId = survey?.subjectId ?: "",
                        couponCodes = eligibleCoupons.map { it.couponCode }.joinToString(","),
                        paymentAmount = paymentAmount,
                        paymentPhone = if (paymentAuditPhoneEnabled) paymentPhone else null,
                        signatureHex = signature,
                        confirmationMethod = confirmationMethod,
                        uploadStatus = "PENDING"
                    )
                    database.recruitmentPaymentUploadStateDao().insert(uploadState)
                    Log.i("RecruitmentPayment", "Created upload state: $paymentId")

                    // Attempt upload in background
                    val uploadManager = RecruitmentPaymentUploadManager(context, database)
                    uploadManager.uploadPayment(paymentId)
                }

                successMessage = paymentSuccessMsg
                kotlinx.coroutines.delay(1500)

                // Navigate back to menu
                navController.navigate(AppDestinations.MENU) {
                    popUpTo(AppDestinations.MENU) { inclusive = false }
                }
            } catch (e: Exception) {
                Log.e("RecruitmentPayment", "Error processing payment", e)
                errorMessage = "Error processing payment: ${e.message}"
            } finally {
                isProcessing = false
            }
        }
    }

    // Function to convert ImageBitmap to hex string
    fun bitmapToHexString(imageBitmap: ImageBitmap): String {
        val bitmap = imageBitmap.asAndroidBitmap()
        val stream = ByteArrayOutputStream()
        bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream)
        val bytes = stream.toByteArray()
        return bytes.joinToString("") { "%02x".format(it) }
    }

    Scaffold(
        topBar = {
            SaltTopAppBar(
                title = stringResource(R.string.recruitment_payment_title),
                navController = navController,
                showBackButton = false,
                showHomeButton = true
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
                    .padding(horizontal = 24.dp)
                    .verticalScroll(scrollState),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                Spacer(modifier = Modifier.height(8.dp))

                // Welcome message
                Icon(
                    imageVector = Icons.Default.AttachMoney,
                    contentDescription = stringResource(R.string.cd_payment),
                    modifier = Modifier.size(64.dp),
                    tint = MaterialTheme.colorScheme.primary
                )

                Text(
                    text = stringResource(R.string.recruitment_payment_welcome),
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary
                )

                // Subject ID display
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
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Text(
                            text = "Subject ID",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Text(
                            text = survey?.subjectId ?: "",
                            style = MaterialTheme.typography.headlineMedium,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }

                // Coupons Card
                Card(
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp)
                    ) {
                        Text(
                            text = stringResource(R.string.recruitment_payment_your_coupons),
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold
                        )

                        Spacer(modifier = Modifier.height(12.dp))

                        if (couponsWithState.isEmpty()) {
                            Text(
                                text = "No coupons issued to this participant.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        } else {
                            couponsWithState.forEach { couponWithState ->
                                val coupon = couponWithState.coupon
                                val state = couponWithState.displayState

                                // Determine icon and colors based on state
                                val (icon, iconColor, statusText, statusColor) = when (state) {
                                    CouponDisplayState.NOT_USED -> Quadruple(
                                        Icons.Default.Close,
                                        Color.Gray,
                                        stringResource(R.string.recruitment_payment_not_used),
                                        Color.Gray
                                    )
                                    CouponDisplayState.INELIGIBLE -> Quadruple(
                                        Icons.Default.Close,
                                        Color(0xFFE53935), // Red
                                        stringResource(R.string.recruitment_payment_ineligible),
                                        Color(0xFFE53935)
                                    )
                                    CouponDisplayState.PENDING -> Quadruple(
                                        Icons.Default.CheckCircle,
                                        Color(0xFF4CAF50), // Green
                                        stringResource(R.string.recruitment_payment_pending),
                                        Color(0xFF4CAF50)
                                    )
                                    CouponDisplayState.PAID -> Quadruple(
                                        Icons.Default.CheckCircle,
                                        Color(0xFF4CAF50), // Green
                                        stringResource(
                                            R.string.recruitment_payment_already_paid,
                                            dateFormatter.format(Date(coupon.recruitmentPaymentDate ?: 0))
                                        ),
                                        Color(0xFF2196F3) // Blue
                                    )
                                }

                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 8.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                                    ) {
                                        Icon(
                                            imageVector = icon,
                                            contentDescription = null,
                                            tint = iconColor,
                                            modifier = Modifier.size(20.dp)
                                        )
                                        Text(
                                            text = coupon.couponCode,
                                            style = MaterialTheme.typography.bodyLarge,
                                            fontWeight = FontWeight.Medium
                                        )
                                    }

                                    Text(
                                        text = statusText,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = statusColor
                                    )
                                }
                                if (couponWithState != couponsWithState.last()) {
                                    HorizontalDivider()
                                }
                            }
                        }
                    }
                }

                // Payment Summary Card
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = if (eligibleCoupons.isNotEmpty())
                            MaterialTheme.colorScheme.primaryContainer
                        else
                            MaterialTheme.colorScheme.surfaceVariant
                    )
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        if (eligibleCoupons.isNotEmpty()) {
                            Text(
                                text = stringResource(
                                    R.string.recruitment_payment_eligible,
                                    eligibleCoupons.size
                                ),
                                style = MaterialTheme.typography.bodyLarge,
                                textAlign = TextAlign.Center
                            )
                            Spacer(modifier = Modifier.height(12.dp))
                            Text(
                                text = stringResource(
                                    R.string.recruitment_payment_total,
                                    currencySymbol,
                                    paymentAmount,
                                    currency
                                ),
                                style = MaterialTheme.typography.headlineSmall,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.primary
                            )
                        } else {
                            Text(
                                text = stringResource(R.string.recruitment_payment_none_eligible),
                                style = MaterialTheme.typography.bodyLarge,
                                textAlign = TextAlign.Center,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }

                // Phone input for payment audit (only when enabled and there are eligible coupons)
                if (paymentAuditPhoneEnabled && eligibleCoupons.isNotEmpty()) {
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

                // Confirmation Section (only if there are eligible coupons)
                if (eligibleCoupons.isNotEmpty()) {
                    if (lookupMethod == "fingerprint") {
                        // Fingerprint confirmation
                        Image(
                            painter = painterResource(id = R.drawable.fingerprint_instruction),
                            contentDescription = "Fingerprint instruction",
                            modifier = Modifier
                                .fillMaxWidth(0.3f)
                                .padding(vertical = 8.dp)
                        )

                        Text(
                            text = stringResource(R.string.recruitment_payment_confirm_fingerprint),
                            style = MaterialTheme.typography.bodyMedium,
                            textAlign = TextAlign.Center
                        )

                        Button(
                            onClick = {
                                scope.launch {
                                    isCapturingFingerprint = true
                                    errorMessage = null

                                    // Check for USB device
                                    val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
                                    val deviceList = usbManager.deviceList
                                    var secugenDevice: UsbDevice? = null

                                    for ((_, device) in deviceList) {
                                        if (device.vendorId == 0x1162) {
                                            secugenDevice = device
                                            break
                                        }
                                    }

                                    if (secugenDevice == null) {
                                        showDeviceNotConnectedDialog = true
                                        isCapturingFingerprint = false
                                        return@launch
                                    }

                                    if (!usbManager.hasPermission(secugenDevice)) {
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
                                        showUsbPermissionDialog = true
                                        isCapturingFingerprint = false
                                        return@launch
                                    }

                                    // Get the subject's stored fingerprint
                                    val subjectFingerprint = withContext(Dispatchers.IO) {
                                        database.subjectFingerprintDao().getFingerprintBySurveyId(surveyId)
                                    }

                                    if (subjectFingerprint == null) {
                                        errorMessage = "No fingerprint on file for this participant."
                                        isCapturingFingerprint = false
                                        return@launch
                                    }

                                    // Create fingerprint implementation
                                    val fingerprintImpl: IFingerprintCapture = com.dev.salt.fingerprint.FingerprintImplFactory.create(context)

                                    if (!fingerprintImpl.initializeDevice()) {
                                        errorMessage = deviceInitError
                                        isCapturingFingerprint = false
                                        return@launch
                                    }

                                    val capturedTemplate = fingerprintImpl.captureFingerprint()
                                    if (capturedTemplate == null) {
                                        errorMessage = captureFailedError
                                        fingerprintImpl.closeDevice()
                                        isCapturingFingerprint = false
                                        return@launch
                                    }

                                    // Match against stored template
                                    val isMatch = fingerprintImpl.matchTemplates(
                                        capturedTemplate,
                                        subjectFingerprint.fingerprintTemplate
                                    )

                                    fingerprintImpl.closeDevice()

                                    if (!isMatch) {
                                        errorMessage = fingerprintMismatchError
                                        isCapturingFingerprint = false
                                        return@launch
                                    }

                                    isCapturingFingerprint = false
                                    processPayment(null, "fingerprint") // No signature needed for fingerprint confirmation
                                }
                            },
                            enabled = !isCapturingFingerprint && !isProcessing,
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(56.dp)
                        ) {
                            if (isCapturingFingerprint) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(24.dp),
                                    color = MaterialTheme.colorScheme.onPrimary
                                )
                            } else {
                                Icon(
                                    imageVector = Icons.Default.Fingerprint,
                                    contentDescription = null,
                                    modifier = Modifier.size(24.dp)
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Text(stringResource(R.string.recruitment_payment_confirm_button))
                            }
                        }
                    } else {
                        // Signature confirmation (coupon_admin_override path)
                        Text(
                            text = stringResource(R.string.recruitment_payment_confirm_signature),
                            style = MaterialTheme.typography.bodyMedium,
                            textAlign = TextAlign.Center
                        )

                        // Signature pad
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(150.dp)
                                .border(2.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(8.dp))
                                .padding(4.dp)
                        ) {
                            Sain(
                                modifier = Modifier.fillMaxSize(),
                                signaturePadColor = MaterialTheme.colorScheme.surface,
                                signatureColor = MaterialTheme.colorScheme.onSurface,
                                onComplete = { bitmap ->
                                    signatureBitmap = bitmap
                                    if (bitmap != null) {
                                        hasDrawnSignature = true
                                    }
                                }
                            ) { action ->
                                signatureAction = action
                            }
                        }

                        // Clear and Confirm buttons
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            OutlinedButton(
                                onClick = {
                                    signatureAction?.invoke(SignatureAction.CLEAR)
                                    signatureBitmap = null
                                    hasDrawnSignature = false
                                },
                                modifier = Modifier.weight(1f)
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Clear,
                                    contentDescription = "Clear",
                                    modifier = Modifier.size(18.dp)
                                )
                                Spacer(modifier = Modifier.width(4.dp))
                                Text("Clear")
                            }

                            Button(
                                onClick = {
                                    signatureAction?.invoke(SignatureAction.COMPLETE)
                                    // Small delay to ensure bitmap is captured
                                    scope.launch {
                                        kotlinx.coroutines.delay(100)
                                        val signature = signatureBitmap?.let { bitmapToHexString(it) }
                                        processPayment(signature, "signature")
                                    }
                                },
                                enabled = hasDrawnSignature && !isProcessing,
                                modifier = Modifier.weight(1f)
                            ) {
                                if (isProcessing) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(24.dp),
                                        color = MaterialTheme.colorScheme.onPrimary
                                    )
                                } else {
                                    Text(stringResource(R.string.recruitment_payment_confirm_button))
                                }
                            }
                        }
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

                // Success message
                successMessage?.let { message ->
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(
                            containerColor = Color(0xFFC8E6C9)
                        )
                    ) {
                        Text(
                            text = message,
                            color = Color(0xFF2E7D32),
                            modifier = Modifier.padding(16.dp),
                            textAlign = TextAlign.Center,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }

                Spacer(modifier = Modifier.weight(1f))

                // Cancel button
                OutlinedButton(
                    onClick = {
                        navController.popBackStack()
                    },
                    enabled = !isProcessing,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 16.dp)
                ) {
                    Text(stringResource(R.string.recruitment_payment_cancel))
                }
            }
        }
    }

    // USB Permission Dialog
    if (showUsbPermissionDialog) {
        AlertDialog(
            onDismissRequest = { showUsbPermissionDialog = false },
            icon = {
                Icon(
                    imageVector = Icons.Default.Fingerprint,
                    contentDescription = "USB Permission",
                    tint = MaterialTheme.colorScheme.primary
                )
            },
            title = { Text("USB Permission Required") },
            text = {
                Text("Please grant USB permission to use the fingerprint scanner.")
            },
            confirmButton = {
                Button(onClick = { showUsbPermissionDialog = false }) {
                    Text("OK")
                }
            }
        )
    }

    // Device Not Connected Dialog
    if (showDeviceNotConnectedDialog) {
        AlertDialog(
            onDismissRequest = { showDeviceNotConnectedDialog = false },
            icon = {
                Icon(
                    imageVector = Icons.Default.Fingerprint,
                    contentDescription = "Device Not Connected",
                    tint = MaterialTheme.colorScheme.error
                )
            },
            title = { Text("Scanner Not Connected") },
            text = {
                Column {
                    Text("The fingerprint scanner is not connected. Please:")
                    Spacer(modifier = Modifier.height(8.dp))
                    Text("1. Connect the SecuGen scanner to the USB port")
                    Text("2. Use a USB OTG adapter if needed")
                    Text("3. Ensure the device is powered on")
                }
            },
            confirmButton = {
                Button(onClick = { showDeviceNotConnectedDialog = false }) {
                    Text("OK")
                }
            }
        )
    }
}
