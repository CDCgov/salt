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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.dev.salt.AppDestinations
import com.dev.salt.R
import com.dev.salt.data.SurveyDatabase
import com.dev.salt.fingerprint.FingerprintManager
import com.dev.salt.fingerprint.IFingerprintCapture
import com.dev.salt.fingerprint.MockFingerprintImpl
import com.dev.salt.fingerprint.SecuGenFingerprintImpl
import com.dev.salt.util.EmulatorDetector
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.activity.compose.BackHandler

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecruitmentLookupScreen(
    navController: NavController
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
    var couponCode by remember { mutableStateOf("") }
    var isSearching by remember { mutableStateOf(false) }
    var isCapturingFingerprint by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var fingerprintEnabled by remember { mutableStateOf(false) }

    // Dialog states
    var showAdminOverrideDialog by remember { mutableStateOf(false) }
    var showDeviceNotConnectedDialog by remember { mutableStateOf(false) }
    var showUsbPermissionDialog by remember { mutableStateOf(false) }
    var isCapturingAdminFingerprint by remember { mutableStateOf(false) }
    var adminOverrideError by remember { mutableStateOf<String?>(null) }
    var pendingSurveyId by remember { mutableStateOf<String?>(null) }

    // Error strings
    val couponNotFoundError = stringResource(R.string.recruitment_coupon_not_found)
    val fingerprintNotFoundError = stringResource(R.string.recruitment_fingerprint_not_found)
    val deviceInitError = stringResource(R.string.fingerprint_device_init_failed)
    val captureFailedError = stringResource(R.string.fingerprint_capture_failed)
    val adminOverrideNoMatch = stringResource(R.string.recruitment_admin_override_no_match)
    val scannerNotConnectedError = stringResource(R.string.payment_error_scanner_not_connected)
    val usbPermissionError = stringResource(R.string.payment_error_usb_permission)

    // Load survey config to check if fingerprint is enabled
    LaunchedEffect(Unit) {
        val surveyConfig = database.surveyConfigDao().getSurveyConfig()
        fingerprintEnabled = surveyConfig?.fingerprintEnabled ?: false
    }

    // Cleanup
    DisposableEffect(Unit) {
        onDispose {
            scope.launch {
                try {
                    fingerprintManager.closeDevice()
                } catch (e: Exception) {
                    Log.e("RecruitmentLookup", "Error closing fingerprint device", e)
                }
            }
        }
    }

    Scaffold(
        topBar = {
            SaltTopAppBar(
                title = stringResource(R.string.recruitment_lookup_title),
                navController = navController,
                showBackButton = true,
                showHomeButton = true,
                requireStaffAuthToLeave = false // staff-only screen
            )
        }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(horizontal = 24.dp)
                .verticalScroll(scrollState),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Spacer(modifier = Modifier.height(16.dp))

            // Title and instructions - show different icon and text based on fingerprint setting
            Icon(
                imageVector = if (fingerprintEnabled) Icons.Default.Fingerprint else Icons.Default.Search,
                contentDescription = if (fingerprintEnabled) stringResource(R.string.cd_fingerprint) else "Search",
                modifier = Modifier.size(64.dp),
                tint = MaterialTheme.colorScheme.primary
            )

            Text(
                text = if (fingerprintEnabled)
                    stringResource(R.string.recruitment_lookup_instruction_fingerprint)
                else
                    stringResource(R.string.recruitment_lookup_instruction_no_fingerprint),
                style = MaterialTheme.typography.bodyLarge,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            // Fingerprint instruction image (if fingerprint enabled)
            if (fingerprintEnabled) {
                Image(
                    painter = painterResource(id = R.drawable.fingerprint_instruction),
                    contentDescription = "Place right index finger on scanner",
                    modifier = Modifier
                        .fillMaxWidth(0.4f)
                        .padding(vertical = 8.dp)
                )

                Text(
                    text = stringResource(R.string.fingerprint_instructions),
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )

                // Scan Fingerprint Button
                Button(
                    onClick = {
                        scope.launch {
                            isCapturingFingerprint = true
                            errorMessage = null

                            // Check for USB device and permission
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

                            // Initialize device
                            if (!fingerprintManager.initializeDevice()) {
                                errorMessage = deviceInitError
                                isCapturingFingerprint = false
                                return@launch
                            }

                            // Capture fingerprint
                            val capturedTemplate = fingerprintManager.captureFingerprint()
                            if (capturedTemplate == null) {
                                errorMessage = captureFailedError
                                fingerprintManager.closeDevice()
                                isCapturingFingerprint = false
                                return@launch
                            }

                            // Get survey config for re-enrollment days
                            val surveyConfig = database.surveyConfigDao().getSurveyConfig()
                            val reEnrollmentDays = surveyConfig?.reEnrollmentDays ?: 90

                            // Search for matching fingerprint
                            val match = fingerprintManager.checkDuplicateEnrollment(
                                capturedTemplate,
                                reEnrollmentDays
                            )

                            fingerprintManager.closeDevice()

                            if (match != null) {
                                // Found a match - navigate to payment screen
                                Log.i("RecruitmentLookup", "Fingerprint match found for survey: ${match.surveyId}")
                                navController.navigate(
                                    "${AppDestinations.RECRUITMENT_PAYMENT}/${match.surveyId}?lookupMethod=fingerprint"
                                )
                            } else {
                                errorMessage = fingerprintNotFoundError
                            }

                            isCapturingFingerprint = false
                        }
                    },
                    enabled = !isCapturingFingerprint && !isSearching,
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
                        Text(stringResource(R.string.recruitment_lookup_fingerprint))
                    }
                }

                // OR divider
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 16.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    HorizontalDivider(modifier = Modifier.weight(1f))
                    Text(
                        text = stringResource(R.string.recruitment_lookup_or),
                        modifier = Modifier.padding(horizontal = 16.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    HorizontalDivider(modifier = Modifier.weight(1f))
                }
            }

            // Coupon code input card
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant
                )
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(
                        text = stringResource(R.string.recruitment_lookup_coupon_label),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    OutlinedTextField(
                        value = couponCode,
                        onValueChange = { value ->
                            if (value.length <= 6) {
                                couponCode = value.uppercase()
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text("XXXXXX") },
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.Characters
                        ),
                        singleLine = true,
                        textStyle = MaterialTheme.typography.headlineMedium.copy(
                            textAlign = TextAlign.Center
                        )
                    )

                    Spacer(modifier = Modifier.height(16.dp))

                    Button(
                        onClick = {
                            scope.launch {
                                isSearching = true
                                errorMessage = null

                                // Search for completed survey by subject_id
                                val survey = withContext(Dispatchers.IO) {
                                    // Only find completed surveys (is_completed = true)
                                    database.surveyDao().getCompletedSurveyBySubjectId(couponCode)
                                }

                                if (survey != null) {
                                    // If fingerprint is enabled, require admin override
                                    if (fingerprintEnabled) {
                                        pendingSurveyId = survey.id
                                        showAdminOverrideDialog = true
                                    } else {
                                        // Fingerprint not enabled, proceed directly
                                        navController.navigate(
                                            "${AppDestinations.RECRUITMENT_PAYMENT}/${survey.id}?lookupMethod=coupon_admin_override"
                                        )
                                    }
                                } else {
                                    errorMessage = couponNotFoundError
                                }

                                isSearching = false
                            }
                        },
                        enabled = couponCode.length >= 1 && !isSearching && !isCapturingFingerprint,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        if (isSearching) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(24.dp),
                                color = MaterialTheme.colorScheme.onPrimary
                            )
                        } else {
                            Text(stringResource(R.string.recruitment_lookup_button))
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

            Spacer(modifier = Modifier.weight(1f))

            // Cancel button
            OutlinedButton(
                onClick = {
                    navController.popBackStack()
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 16.dp)
            ) {
                Text(stringResource(R.string.recruitment_payment_cancel))
            }
        }
    }

    // Admin Override Dialog
    if (showAdminOverrideDialog) {
        AlertDialog(
            onDismissRequest = {
                if (!isCapturingAdminFingerprint) {
                    showAdminOverrideDialog = false
                    adminOverrideError = null
                    pendingSurveyId = null
                }
            },
            title = { Text(stringResource(R.string.recruitment_admin_override_required)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        stringResource(R.string.recruitment_admin_override_message),
                        style = MaterialTheme.typography.bodyMedium
                    )

                    if (isCapturingAdminFingerprint) {
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            CircularProgressIndicator(modifier = Modifier.size(20.dp))
                            Text(stringResource(R.string.payment_admin_override_scanning))
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
                                adminOverrideError = scannerNotConnectedError
                                isCapturingAdminFingerprint = false
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
                                adminOverrideError = usbPermissionError
                                isCapturingAdminFingerprint = false
                                return@launch
                            }

                            // Create fingerprint implementation
                            val fingerprintImpl: IFingerprintCapture = if (EmulatorDetector.isEmulator()) {
                                MockFingerprintImpl()
                            } else {
                                try {
                                    SecuGenFingerprintImpl(context)
                                } catch (e: Exception) {
                                    MockFingerprintImpl()
                                }
                            }

                            if (!fingerprintImpl.initializeDevice()) {
                                adminOverrideError = deviceInitError
                                isCapturingAdminFingerprint = false
                                return@launch
                            }

                            val capturedTemplate = fingerprintImpl.captureFingerprint()
                            if (capturedTemplate == null) {
                                adminOverrideError = captureFailedError
                                fingerprintImpl.closeDevice()
                                isCapturingAdminFingerprint = false
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
                                return@launch
                            }

                            Log.i("RecruitmentLookup", "Admin ${matchedAdmin.fullName} authorized lookup")

                            showAdminOverrideDialog = false
                            isCapturingAdminFingerprint = false

                            // Navigate to payment screen
                            pendingSurveyId?.let { surveyId ->
                                navController.navigate(
                                    "${AppDestinations.RECRUITMENT_PAYMENT}/$surveyId?lookupMethod=coupon_admin_override"
                                )
                            }
                        }
                    },
                    enabled = !isCapturingAdminFingerprint
                ) {
                    Text(stringResource(R.string.recruitment_admin_override_scan))
                }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        showAdminOverrideDialog = false
                        adminOverrideError = null
                        pendingSurveyId = null
                    },
                    enabled = !isCapturingAdminFingerprint
                ) {
                    Text(stringResource(R.string.recruitment_payment_cancel))
                }
            }
        )
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
                    imageVector = Icons.Default.Warning,
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
