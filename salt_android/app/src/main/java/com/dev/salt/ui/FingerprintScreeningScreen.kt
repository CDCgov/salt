package com.dev.salt.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material.icons.filled.Warning
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.dev.salt.AppDestinations
import com.dev.salt.data.SurveyDatabase
import com.dev.salt.fingerprint.FingerprintManager
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.res.painterResource
import com.dev.salt.R
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import com.dev.salt.logging.AppLogger as Log
import androidx.compose.runtime.DisposableEffect
import androidx.activity.compose.BackHandler

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FingerprintScreeningScreen(
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
    val fingerprintManager = remember { FingerprintManager(database.subjectFingerprintDao(), context) }
    val scope = rememberCoroutineScope()
    
    var isCapturing by remember { mutableStateOf(false) }
    var showDuplicateDialog by remember { mutableStateOf(false) }
    var daysUntilReEnrollment by remember { mutableStateOf(0) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var showUsbPermissionDialog by remember { mutableStateOf(false) }
    var showDeviceNotConnectedDialog by remember { mutableStateOf(false) }
    var showQualityDialog by remember { mutableStateOf(false) }
    var retryCount by remember { mutableStateOf(0) }
    
    // Load survey configuration
    var reEnrollmentDays by remember { mutableStateOf(90) }
    var facilityId by remember { mutableStateOf<Int?>(null) }
    
    LaunchedEffect(Unit) {
        val surveyConfig = database.surveyConfigDao().getSurveyConfig()
        reEnrollmentDays = surveyConfig?.reEnrollmentDays ?: 90
        // Get facility ID from facility config if needed
        val facilityConfig = database.facilityConfigDao().getFacilityConfig()
        facilityId = facilityConfig?.facilityId
    }

    // Clean up fingerprint device when screen is disposed
    DisposableEffect(Unit) {
        onDispose {
            scope.launch {
                try {
                    Log.d("FingerprintScreeningScreen", "Cleaning up fingerprint device")
                    fingerprintManager.closeDevice()
                } catch (e: Exception) {
                    Log.e("FingerprintScreeningScreen", "Error closing fingerprint device", e)
                }
            }
        }
    }

    Scaffold(
        topBar = {
            SaltTopAppBar(
                title = stringResource(R.string.fingerprint_title),
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
                .padding(horizontal = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceEvenly
        ) {
            // Title and Instructions
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.padding(vertical = 16.dp)
            ) {
                Icon(
                    imageVector = Icons.Default.Fingerprint,
                    contentDescription = stringResource(R.string.cd_fingerprint),
                    modifier = Modifier
                        .size(64.dp)
                        .padding(bottom = 16.dp),
                    tint = MaterialTheme.colorScheme.primary
                )
                
                Text(
                    text = stringResource(R.string.fingerprint_verification_required),
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(bottom = 8.dp)
                )
                
                Text(
                    text = stringResource(R.string.fingerprint_instructions),
                    style = MaterialTheme.typography.bodyLarge,
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            
            // Visual Diagram showing fingerprint placement
            Image(
                painter = painterResource(id = R.drawable.fingerprint_instruction),
                contentDescription = stringResource(R.string.cd_fingerprint_instruction),
                modifier = Modifier
                    .fillMaxWidth(0.5f) // Scale to 50% width
                    .padding(vertical = 16.dp)
            )

            // Instructions
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                InstructionStep(1, stringResource(R.string.fingerprint_enrollment_step1))
                InstructionStep(2, stringResource(R.string.fingerprint_instruction_step2))
                InstructionStep(3, stringResource(R.string.fingerprint_enrollment_step3))
                InstructionStep(4, stringResource(R.string.fingerprint_enrollment_step4))
            }
            
            // Error message
            errorMessage?.let { message ->
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 8.dp),
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

            // Capture Button
            // Get error messages outside onClick lambda
            val deviceInitError = stringResource(R.string.fingerprint_device_init_failed)
            val captureFailedError = stringResource(R.string.fingerprint_capture_failed)

            Button(
                onClick = {
                    scope.launch {
                        // temporary bypass for testing TODO remove for production
                        //val route = "${AppDestinations.LANGUAGE_SELECTION}/$surveyId?couponCode=${couponCode ?: ""}"
                        //navController.navigate(route) {
                        //    popUpTo(AppDestinations.FINGERPRINT_SCREENING) { inclusive = true }
                        //}

                        isCapturing = true
                        errorMessage = null

                        Log.i("FingerprintScreen", "Starting fingerprint capture process")

                        // Check for USB device and permission
                        val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
                        val deviceList = usbManager.deviceList
                        var secugenDevice: UsbDevice? = null

                        for ((_, device) in deviceList) {
                            if (device.vendorId == 0x1162) { // SecuGen vendor ID
                                secugenDevice = device
                                break
                            }
                        }

                        // Check if device is connected
                        if (secugenDevice == null) {
                            Log.e("FingerprintScreen", "No SecuGen device found")
                            showDeviceNotConnectedDialog = true
                            isCapturing = false
                            return@launch
                        }

                        // Check USB permission
                        if (!usbManager.hasPermission(secugenDevice)) {
                            Log.i("FingerprintScreen", "Requesting USB permission")

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
                            isCapturing = false
                            return@launch
                        }

                        // Initialize device
                        Log.i("FingerprintScreen", "Initializing fingerprint device")
                        if (!fingerprintManager.initializeDevice()) {
                            Log.e("FingerprintScreen", "Device initialization failed")
                            errorMessage = deviceInitError
                            isCapturing = false
                            return@launch
                        }

                        // Capture fingerprint with retry logic for quality
                        Log.i("FingerprintScreen", "Capturing fingerprint")
                        val fingerprintTemplate = fingerprintManager.captureFingerprint()

                        if (fingerprintTemplate == null) {
                            Log.e("FingerprintScreen", "Capture failed")
                            retryCount++
                            if (retryCount >= 3) {
                                errorMessage = captureFailedError
                                retryCount = 0
                            } else {
                                showQualityDialog = true
                            }
                            isCapturing = false
                            fingerprintManager.closeDevice()
                            return@launch
                        }

                        Log.i("FingerprintScreen", "Fingerprint captured successfully")
                        retryCount = 0

                        // Check for duplicate enrollment
                        // A failed comparison must not be treated as "no duplicate".
                        val duplicate = try {
                            fingerprintManager.checkDuplicateEnrollment(
                                fingerprintTemplate,
                                reEnrollmentDays
                            )
                        } catch (e: com.dev.salt.fingerprint.FingerprintMatchException) {
                            Log.e("FingerprintScreen", "Duplicate check could not be completed", e)
                            errorMessage = captureFailedError
                            fingerprintManager.closeDevice()
                            isCapturing = false
                            return@launch
                        }

                        if (duplicate != null) {
                            // Calculate days until re-enrollment allowed
                            val daysSinceEnrollment = TimeUnit.MILLISECONDS.toDays(
                                System.currentTimeMillis() - duplicate.enrollmentDate
                            )
                            daysUntilReEnrollment = (reEnrollmentDays - daysSinceEnrollment).toInt()
                            showDuplicateDialog = true
                        } else {
                            // Store fingerprint and proceed
                            fingerprintManager.storeFingerprint(surveyId, fingerprintTemplate, facilityId)

                            // Navigate to language selection
                            val route = "${AppDestinations.LANGUAGE_SELECTION}/$surveyId?couponCode=${couponCode ?: ""}"
                            navController.navigate(route) {
                                popUpTo(AppDestinations.FINGERPRINT_SCREENING) { inclusive = true }
                            }
                        }

                        fingerprintManager.closeDevice()
                        isCapturing = false
                    }
                },
                enabled = !isCapturing,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp)
            ) {
                if (isCapturing) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp),
                        color = MaterialTheme.colorScheme.onPrimary
                    )
                } else {
                    Text(
                        stringResource(R.string.fingerprint_capture_button),
                        style = MaterialTheme.typography.titleMedium
                    )
                }
            }
            
            // Skip button (for testing only - remove in production)
            if (false) { // Set to true for testing
                TextButton(
                    onClick = {
                        navController.navigate("${AppDestinations.LANGUAGE_SELECTION}/$surveyId?couponCode=${couponCode ?: ""}")
                    }
                ) {
                    Text(stringResource(R.string.fingerprint_skip_testing))
                }
            }
        }
    }
    
    // Duplicate Enrollment Dialog
    if (showDuplicateDialog) {
        AlertDialog(
            onDismissRequest = { },
            icon = {
                Icon(
                    imageVector = Icons.Default.Warning,
                    contentDescription = stringResource(R.string.cd_warning),
                    tint = MaterialTheme.colorScheme.error
                )
            },
            title = {
                Text(
                    stringResource(R.string.fingerprint_duplicate_title),
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold
                )
            },
            text = {
                Column {
                    Text(
                        stringResource(R.string.fingerprint_duplicate_message),
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.padding(bottom = 8.dp)
                    )
                    Text(
                        stringResource(R.string.fingerprint_reenrollment_days, daysUntilReEnrollment),
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        // Navigate back to menu
                        navController.navigate(AppDestinations.MENU) {
                            popUpTo(AppDestinations.MENU) { inclusive = false }
                        }
                    }
                ) {
                    Text(stringResource(R.string.fingerprint_return_to_menu))
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
                    contentDescription = stringResource(R.string.cd_usb_permission),
                    tint = MaterialTheme.colorScheme.primary
                )
            },
            title = {
                Text(
                    stringResource(R.string.usb_permission_title),
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold
                )
            },
            text = {
                Text(
                    stringResource(R.string.usb_permission_message_full),
                    style = MaterialTheme.typography.bodyLarge
                )
            },
            confirmButton = {
                Button(
                    onClick = { showUsbPermissionDialog = false }
                ) {
                    Text(stringResource(R.string.common_ok))
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
                    contentDescription = stringResource(R.string.cd_device_not_connected),
                    tint = MaterialTheme.colorScheme.error
                )
            },
            title = {
                Text(
                    stringResource(R.string.scanner_not_connected_title),
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold
                )
            },
            text = {
                Column {
                    Text(
                        stringResource(R.string.scanner_not_connected_message),
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.padding(bottom = 8.dp)
                    )
                    Text(stringResource(R.string.scanner_not_connected_step1))
                    Text(stringResource(R.string.scanner_not_connected_step2))
                    Text(stringResource(R.string.scanner_not_connected_step3))
                    Text(stringResource(R.string.scanner_not_connected_step4))
                }
            },
            confirmButton = {
                Button(
                    onClick = { showDeviceNotConnectedDialog = false }
                ) {
                    Text(stringResource(R.string.common_ok))
                }
            }
        )
    }

    // Quality Issue Dialog
    if (showQualityDialog) {
        AlertDialog(
            onDismissRequest = { showQualityDialog = false },
            icon = {
                Icon(
                    imageVector = Icons.Default.Fingerprint,
                    contentDescription = stringResource(R.string.cd_quality_issue),
                    tint = MaterialTheme.colorScheme.primary
                )
            },
            title = {
                Text(
                    stringResource(R.string.low_quality_title),
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold
                )
            },
            text = {
                Column {
                    Text(
                        stringResource(R.string.low_quality_message),
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.padding(bottom = 8.dp)
                    )
                    Text("• " + stringResource(R.string.low_quality_step1))
                    Text("• " + stringResource(R.string.low_quality_step2))
                    Text("• " + stringResource(R.string.low_quality_step3))
                    Text("• " + stringResource(R.string.low_quality_step4))
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        stringResource(R.string.fingerprint_attempt_of, retryCount, 3),
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.Bold
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = { showQualityDialog = false }
                ) {
                    Text(stringResource(R.string.low_quality_try_again))
                }
            }
        )
    }
}

@Composable
fun InstructionStep(number: Int, text: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Start
    ) {
        Card(
            modifier = Modifier.size(32.dp),
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.primary
            )
        ) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier.fillMaxSize()
            ) {
                Text(
                    text = number.toString(),
                    color = MaterialTheme.colorScheme.onPrimary,
                    fontWeight = FontWeight.Bold
                )
            }
        }
        
        Spacer(modifier = Modifier.width(12.dp))
        
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f)
        )
    }
}
