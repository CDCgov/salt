package com.dev.salt


import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.BackHandler
// If you are using by viewModels() for Activity-level ViewModels, keep this:
// import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.TextButton
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.viewmodel.compose.viewModel // For viewModel() composable function
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import androidx.navigation.NavType
import com.dev.salt.data.SurveyDatabase
import com.dev.salt.ui.theme.SALTTheme
import com.dev.salt.viewmodel.LoginViewModel
import com.dev.salt.viewmodel.SurveyViewModel
import com.dev.salt.viewmodel.UserRole
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import com.dev.salt.viewmodel.LoginViewModelFactory
import com.dev.salt.auth.BiometricAuthManager
import com.dev.salt.auth.BiometricAuthManagerFactory
import com.dev.salt.session.SessionManager
import com.dev.salt.session.SessionManagerInstance
import com.dev.salt.session.SessionEvent
import com.dev.salt.session.SurveyStateManagerInstance
import com.dev.salt.ui.SessionTimeoutDialog
import com.dev.salt.ui.SessionExpiredDialog
import com.dev.salt.ui.ActivityDetector
import com.dev.salt.ui.LogoutButton
import com.dev.salt.ui.ReturnToMenuButton
import com.dev.salt.ui.ServerSettingsScreen
import com.dev.salt.ui.UploadStatusScreen
import com.dev.salt.ui.LanguageSettingsScreen
import com.dev.salt.ui.StaffFingerprintEnrollmentScreen
import com.dev.salt.upload.SurveyUploadWorkManager
import com.dev.salt.i18n.LanguageManager
import com.dev.salt.ui.DeveloperSettingsScreen
import com.dev.salt.logging.AppLogger as Log
import androidx.lifecycle.viewModelScope

// Import your screen Composables if they are in separate files
// e.g., import com.dev.salt.ui.WelcomeScreen
// e.g., import com.dev.salt.ui.LoginScreen
// e.g., import com.dev.salt.ui.MenuScreen
// e.g., import com.dev.salt.ui.AdminDashboardScreen

object AppDestinations {
    const val WELCOME = "welcome"
    const val LOGIN = "login"
    const val MENU = "menu" // Assuming this is where survey_staff goes
    const val ADMIN_DASHBOARD = "admin_dashboard" // For administrators
    const val USER_MANAGEMENT = "user_management" // For user management
    const val SURVEY = "survey" // For survey-related screens
    const val SERVER_SETTINGS = "server_settings" // For server configuration
    const val UPLOAD_STATUS = "upload_status" // For upload status dashboard
    const val COUPON = "coupon" // For coupon validation
    const val COUPON_ISSUED = "coupon_issued" // For displaying issued coupons
    const val CONSENT_INSTRUCTION = "consent_instruction" // For staff instruction before consent
    const val CONSENT_SIGNATURE = "consent_signature" // For consent agreement signature capture
    const val CONTACT_CONSENT = "contact_consent" // For asking about future contact
    const val CONTACT_INFO = "contact_info" // For collecting contact information
    const val SEED_RECRUITMENT = "seed_recruitment" // For seed recruitment screen
    const val LANGUAGE_SELECTION = "language_selection" // For language selection screen
    const val FINGERPRINT_SCREENING = "fingerprint_screening" // For fingerprint screening
    const val MANUAL_DUPLICATE_CHECK = "manual_duplicate_check" // For manual duplicate check when fingerprinting disabled
    const val STAFF_VALIDATION = "staff_validation" // For staff validation/handoff
    const val LAB_COLLECTION = "lab_collection" // For lab sample collection
    const val STAFF_INSTRUCTION = "staff_instruction" // For staff instructions before giving tablet to participant
    const val SURVEY_START_INSTRUCTION = "survey_start_instruction" // For pre-survey instructions (staff vs participant)
    const val SUBJECT_PAYMENT = "subject_payment" // For subject payment confirmation
    const val WALKIN_RECRUITMENT_PAYMENT = "walkin_recruitment_payment" // For walk-in recruitment payment instructions
    const val LANGUAGE_SETTINGS = "language_settings" // For app language settings
    const val STAFF_FINGERPRINT_ENROLLMENT = "staff_fingerprint_enrollment" // For staff fingerprint enrollment
    const val FACILITY_SETUP = "facility_setup" // For facility setup with short code
    const val HIV_TEST_INSTRUCTION = "hiv_test_instruction" // Deprecated - use RAPID_TEST_INSTRUCTION
    const val HIV_TEST_RESULT = "hiv_test_result" // Deprecated - use RAPID_TEST_RESULT
    const val HIV_TEST_STAFF_VALIDATION = "hiv_test_staff_validation" // Deprecated
    const val HAND_TABLET_BACK = "hand_tablet_back" // For handing tablet back to participant
    const val RAPID_TEST_INSTRUCTION = "rapid_test_instruction" // For generic rapid test instruction
    const val RAPID_TEST_RESULT = "rapid_test_result" // For generic rapid test result entry
    const val SAMPLE_COLLECTION_STAFF_VALIDATION = "sample_collection_staff_validation" // Staff validation before sample collection
    const val BIOLOGICAL_SAMPLE_COLLECTION = "biological_sample_collection" // Biological sample collection confirmation
    const val TABLET_HANDOFF = "tablet_handoff" // For handoff to participant after sample collection
    const val INITIAL_SERVER_CONFIG = "initial_server_config" // For initial server setup wizard
    const val INITIAL_ADMIN_SETUP = "initial_admin_setup" // For initial admin user creation
    const val INITIAL_FINGERPRINT_SETUP = "initial_fingerprint_setup" // For initial admin fingerprint enrollment
    const val RECRUITMENT_LOOKUP = "recruitment_lookup" // For recruitment payment lookup
    const val RECRUITMENT_PAYMENT = "recruitment_payment" // For recruitment payment confirmation
    const val DEVELOPER_SETTINGS = "developer_settings" // For developer/debug settings
    const val COUPON_LOGGING = "coupon_logging" // For coupon logging screen

    // Compatibility aliases for existing code
    const val WELCOME_SCREEN = WELCOME
    const val LOGIN_SCREEN = LOGIN
    const val MENU_SCREEN = MENU
    const val ADMIN_DASHBOARD_SCREEN = ADMIN_DASHBOARD
    const val USER_MANAGEMENT_SCREEN = USER_MANAGEMENT
    const val SURVEY_SCREEN = SURVEY
    const val SERVER_SETTINGS_SCREEN = SERVER_SETTINGS
    const val UPLOAD_STATUS_SCREEN = UPLOAD_STATUS
    const val COUPON_SCREEN = COUPON
    const val COUPON_ISSUED_SCREEN = COUPON_ISSUED
    const val WALKIN_RECRUITMENT_PAYMENT_SCREEN = WALKIN_RECRUITMENT_PAYMENT
}
/*delete the database*/
/*database.clearAllTables()
val viewModel: SurveyViewModel = viewModel { SurveyViewModel(database) }
val surveyApplication = SurveyApplication()
surveyApplication.populateSampleData()
surveyApplication.copyRawFilesToLocalStorage(this)
val coroutineScope = rememberCoroutineScope()
SurveyScreen(viewModel, coroutineScope)*/

class MainActivity : ComponentActivity() {
    override fun attachBaseContext(newBase: Context) {
        // Apply the saved language preference
        super.attachBaseContext(LanguageManager.wrapContext(newBase))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Get DAO instance once here to pass to the factory
        // This assumes SurveyDatabase.getInstance() and userDao() are correctly set up
        val userDao = SurveyDatabase.getInstance(applicationContext).userDao()
        val biometricAuthManager = BiometricAuthManagerFactory.create(applicationContext, userDao)
        val sessionManager = SessionManagerInstance.instance
        val surveyStateManager = SurveyStateManagerInstance.instance
        val loginViewModelFactory = LoginViewModelFactory(applicationContext, userDao, biometricAuthManager, sessionManager)
        
        // Initialize upload work manager and schedule periodic retries
        val uploadWorkManager = SurveyUploadWorkManager(applicationContext)
        uploadWorkManager.schedulePeriodicRetries()

        setContent {
            SALTTheme {
                // Create a NavHostController
                val navController = rememberNavController()

                // Session management states
                val sessionState by sessionManager.sessionState.collectAsState()
                val sessionEvent by sessionManager.sessionEvents.collectAsState()
                val surveyState by surveyStateManager.surveyState.collectAsState()

                // Map to store SurveyViewModels by surveyId to ensure single instance
                val surveyViewModels = remember { mutableStateMapOf<String, SurveyViewModel>() }
                var showSessionWarning by remember { mutableStateOf(false) }
                var showSessionExpired by remember { mutableStateOf(false) }

                // Sync message to display after login
                var pendingSyncMessage by remember { mutableStateOf<SyncMessage?>(null) }
                
                // Logout function
                val handleLogout = {
                    sessionManager.logout()
                    surveyStateManager.endSurvey()
                    navController.navigate(AppDestinations.LOGIN_SCREEN) {
                        popUpTo(navController.graph.startDestinationId) {
                            inclusive = true
                        }
                        launchSingleTop = true
                    }
                }

                // Return to menu function - always navigates to staff menu
                val handleReturnToMenu = {
                    navController.navigate(AppDestinations.MENU_SCREEN) {
                        popUpTo(AppDestinations.MENU_SCREEN) { inclusive = false }
                        launchSingleTop = true
                    }
                }

                // Handle session events
                LaunchedEffect(sessionEvent) {
                    when (sessionEvent) {
                        is SessionEvent.SessionWarning -> {
                            showSessionWarning = true
                        }
                        is SessionEvent.SessionExpired -> {
                            showSessionExpired = true
                            // Navigate to login screen
                            navController.navigate(AppDestinations.LOGIN_SCREEN) {
                                popUpTo(navController.graph.startDestinationId) {
                                    inclusive = true
                                }
                                launchSingleTop = true
                            }
                        }
                        else -> {}
                    }
                }

                // Session timeout warning dialog
                if (showSessionWarning) {
                    SessionTimeoutDialog(
                        timeUntilExpiration = sessionManager.getTimeUntilExpiration(),
                        onExtendSession = {
                            sessionManager.extendSession()
                            showSessionWarning = false
                            sessionManager.clearSessionEvent()
                        },
                        onLogout = {
                            sessionManager.endSession()
                            showSessionWarning = false
                            sessionManager.clearSessionEvent()
                            navController.navigate(AppDestinations.LOGIN_SCREEN) {
                                popUpTo(navController.graph.startDestinationId) {
                                    inclusive = true
                                }
                                launchSingleTop = true
                            }
                        }
                    )
                }

                // Session expired dialog
                if (showSessionExpired) {
                    SessionExpiredDialog(
                        onDismiss = {
                            showSessionExpired = false
                            sessionManager.clearSessionEvent()
                        }
                    )
                }

                // Set up the NavHost wrapped in ActivityDetector
                ActivityDetector {
                    NavHost(navController = navController, startDestination = AppDestinations.WELCOME_SCREEN) {
                    composable(AppDestinations.WELCOME_SCREEN) {
                        // delete the database
                        //database.clearAllTables()
                        val context: Context = LocalContext.current
                        val database = SurveyDatabase.getInstance(context)
                        val surveyApplication = SurveyApplication()
                        surveyApplication.populateSampleData()
                        surveyApplication.copyRawFilesToLocalStorage(context)

                        // Check if setup is needed (users and facility configuration)
                        var setupComplete by remember { mutableStateOf(false) }
                        var isCheckingConfig by remember { mutableStateOf(true) }

                        LaunchedEffect(Unit) {
                            // Check if any users exist (first-time setup check)
                            val userCount = database.userDao().getAllUsers().size

                            if (userCount == 0) {
                                // No users - navigate to initial server config (Phase 1)
                                isCheckingConfig = false
                                navController.navigate(AppDestinations.INITIAL_SERVER_CONFIG) {
                                    popUpTo(AppDestinations.WELCOME_SCREEN) { inclusive = true }
                                }
                                return@LaunchedEffect
                            }

                            // Users exist - check facility configuration
                            val facilityConfig = database.facilityConfigDao().getFacilityConfig()
                            val serverConfig = database.appServerConfigDao().getServerConfig()
                            val facilityConfigured = facilityConfig?.facilityId != null && serverConfig?.apiKey != null
                            setupComplete = facilityConfigured
                            isCheckingConfig = false

                            // Auto-navigate to facility setup if not configured
                            if (!facilityConfigured) {
                                navController.navigate("${AppDestinations.FACILITY_SETUP}?showCancel=false") {
                                    popUpTo(AppDestinations.WELCOME_SCREEN) { inclusive = true }
                                }
                            }
                        }

                        if (!isCheckingConfig && setupComplete) {
                            WelcomeScreen(navController = navController)
                        } else {
                            Box(
                                modifier = Modifier.fillMaxSize(),
                                contentAlignment = Alignment.Center
                            ) {
                                CircularProgressIndicator()
                            }
                        }
                    }

                    composable(AppDestinations.INITIAL_SERVER_CONFIG) {
                        com.dev.salt.ui.InitialServerConfigScreen(
                            onServerConfigured = {
                                // Navigate to admin user creation (Phase 2)
                                navController.navigate(AppDestinations.INITIAL_ADMIN_SETUP) {
                                    popUpTo(AppDestinations.INITIAL_SERVER_CONFIG) { inclusive = true }
                                }
                            }
                        )
                    }

                    composable(AppDestinations.INITIAL_ADMIN_SETUP) {
                        com.dev.salt.ui.InitialAdminSetupScreen(
                            onAdminInfoCollected = { username, fullName, password ->
                                // Navigate to fingerprint enrollment with user info
                                navController.navigate("${AppDestinations.INITIAL_FINGERPRINT_SETUP}/$username/$fullName/$password") {
                                    popUpTo(AppDestinations.INITIAL_ADMIN_SETUP) { inclusive = true }
                                }
                            }
                        )
                    }

                    composable(
                        route = "${AppDestinations.INITIAL_FINGERPRINT_SETUP}/{username}/{fullName}/{password}",
                        arguments = listOf(
                            navArgument("username") { type = NavType.StringType },
                            navArgument("fullName") { type = NavType.StringType },
                            navArgument("password") { type = NavType.StringType }
                        )
                    ) { backStackEntry ->
                        val username = backStackEntry.arguments?.getString("username") ?: ""
                        val fullName = backStackEntry.arguments?.getString("fullName") ?: ""
                        val password = backStackEntry.arguments?.getString("password") ?: ""

                        com.dev.salt.ui.InitialFingerprintSetupScreen(
                            username = username,
                            fullName = fullName,
                            password = password,
                            onSetupComplete = {
                                // Navigate to facility setup after admin user is created
                                navController.navigate("${AppDestinations.FACILITY_SETUP}?showCancel=false") {
                                    popUpTo(AppDestinations.INITIAL_FINGERPRINT_SETUP) { inclusive = true }
                                }
                            }
                        )
                    }

                    composable(
                        route = "${AppDestinations.FACILITY_SETUP}?showCancel={showCancel}",
                        arguments = listOf(
                            navArgument("showCancel") {
                                type = NavType.BoolType
                                defaultValue = false
                            }
                        )
                    ) { backStackEntry ->
                        val showCancel = backStackEntry.arguments?.getBoolean("showCancel") ?: false
                        val context = LocalContext.current
                        val database = SurveyDatabase.getInstance(context)
                        com.dev.salt.ui.FacilitySetupScreen(
                            navController = navController,
                            database = database,
                            showCancel = showCancel
                        )
                    }

                    composable(AppDestinations.LOGIN_SCREEN) {
                        // Pass the LoginViewModel and the navigation callback
                        val loginViewModel: LoginViewModel = viewModel(
                            factory = loginViewModelFactory
                        )
                        LoginScreen(
                            loginViewModel = loginViewModel,
                            onLoginSuccess = { role, syncMessage ->
                                // Store sync message for display on menu screen
                                pendingSyncMessage = syncMessage

                                // Navigate to the appropriate screen based on user role
                                // It's good practice to clear the back stack up to the login screen
                                // or even further if login is a one-time entry point to a section.
                                val route = when (role) {
                                    UserRole.SURVEY_STAFF -> AppDestinations.MENU_SCREEN
                                    UserRole.ADMINISTRATOR -> AppDestinations.ADMIN_DASHBOARD_SCREEN
                                    UserRole.NONE -> AppDestinations.LOGIN_SCREEN // Or handle error, stay on login
                                }
                                navController.navigate(route) {
                                    // Pop up to the start destination of the graph to
                                    // avoid building up a large back stack.
                                    // Or popUpTo(AppDestinations.LOGIN_SCREEN) { inclusive = true }
                                    // if you want to remove LoginScreen from backstack.
                                    popUpTo(navController.graph.startDestinationId) {
                                        inclusive = true // Or false depending on whether you want to keep welcome screen
                                    }
                                    launchSingleTop = true // Avoid multiple copies of the destination
                                }
                            }
                        )
                    }
                    composable(AppDestinations.MENU_SCREEN) {
                        // You might need a SurveyViewModel here or other ViewModels
                        // val surveyViewModel: SurveyViewModel = viewModel()
                        MenuScreen(
                            navController = navController,
                            onLogout = handleLogout,
                            showLogout = true,
                            syncMessage = pendingSyncMessage,
                            onSyncMessageDismissed = { pendingSyncMessage = null }
                        )
                    }
                    composable(AppDestinations.ADMIN_DASHBOARD_SCREEN) {
                        AdminDashboardScreen(
                            navController = navController,
                            onLogout = handleLogout,
                            showLogout = true,
                            syncMessage = pendingSyncMessage,
                            onSyncMessageDismissed = { pendingSyncMessage = null }
                        )
                    }
                    composable(AppDestinations.USER_MANAGEMENT_SCREEN) {
                        val context = LocalContext.current
                        val userDao = SurveyDatabase.getInstance(context).userDao()
                        val biometricAuthManager = BiometricAuthManagerFactory.create(context, userDao)
                        val userManagementViewModel: com.dev.salt.viewmodel.UserManagementViewModel = viewModel {
                            com.dev.salt.viewmodel.UserManagementViewModel(userDao, biometricAuthManager)
                        }
                        UserManagementScreen(
                            viewModel = userManagementViewModel,
                            navController = navController,
                            onLogout = handleLogout,
                            showLogout = true
                        )
                    }

                    composable(AppDestinations.COUPON_SCREEN) {
                        val context: Context = LocalContext.current
                        val database = SurveyDatabase.getInstance(context)
                        com.dev.salt.ui.CouponScreen(
                            navController = navController,
                            database = database
                        )
                    }

                    composable(
                        route = "${AppDestinations.SURVEY_START_INSTRUCTION}?surveyId={surveyId}&couponCode={couponCode}",
                        arguments = listOf(
                            navArgument("surveyId") {
                                type = NavType.StringType
                                nullable = false
                            },
                            navArgument("couponCode") {
                                type = NavType.StringType
                                nullable = false
                            }
                        )
                    ) { backStackEntry ->
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        val couponCode = backStackEntry.arguments?.getString("couponCode") ?: ""
                        val context: Context = LocalContext.current
                        val database = SurveyDatabase.getInstance(context)
                        com.dev.salt.ui.SurveyStartInstructionScreen(
                            navController = navController,
                            database = database,
                            surveyId = surveyId,
                            couponCode = couponCode
                        )
                    }

                    composable(
                        route = AppDestinations.SURVEY_SCREEN + "?couponCode={couponCode}",
                        arguments = listOf(
                            androidx.navigation.navArgument("couponCode") {
                                type = androidx.navigation.NavType.StringType
                                nullable = true
                                defaultValue = null
                            }
                        )
                    ) { backStackEntry ->
                        val context: Context = LocalContext.current
                        // Pass navController to SurveyScreen
                        val database = SurveyDatabase.getInstance(context)
                        // Get the coupon code from navigation arguments
                        val referralCouponCode: String? = backStackEntry.arguments?.getString("couponCode")

                        // Find the most recent survey that matches this referral coupon code
                        val scope = rememberCoroutineScope()
                        var surveyId by remember { mutableStateOf<String?>(null) }
                        var isLoading by remember { mutableStateOf(true) }

                        LaunchedEffect(referralCouponCode) {
                            // Find the most recent survey (it should have been created at language selection)
                            Log.d("MainActivity", "Looking for most recent survey (coupon code passed: $referralCouponCode)")
                            val recentSurvey = database.surveyDao().getMostRecentSurvey()
                            surveyId = recentSurvey?.id
                            Log.d("MainActivity", "Found survey: $surveyId with language: ${recentSurvey?.language}")
                            isLoading = false
                        }

                        val finalSurveyId = surveyId
                        if (!isLoading && finalSurveyId != null) {
                            // Get or create ViewModel from shared map to ensure single instance
                            val viewModel: SurveyViewModel = surveyViewModels.getOrPut(finalSurveyId) {
                                viewModel(key = finalSurveyId) {
                                    com.dev.salt.viewmodel.SurveyViewModelFactory(database, context, referralCouponCode, finalSurveyId).create(SurveyViewModel::class.java)
                                }
                            }
                            val coroutineScope = rememberCoroutineScope()
                            SurveyScreen(
                                viewModel = viewModel,
                                coroutineScope = coroutineScope,
                                onNavigateBack = {
                                    // Check if this is an eligibility failure (survey ended early due to ineligibility)
                                    val generatedCoupons = viewModel.generatedCoupons.value
                                    val innerSurveyId = viewModel.survey?.id ?: ""
                                    val wasIneligible = viewModel.needsEligibilityCheck.value && viewModel.isEligible.value == false

                                    Log.d("MainActivity", "=== SURVEY COMPLETION - onNavigateBack ===")
                                    Log.d("MainActivity", "Survey ID: $innerSurveyId")
                                    Log.d("MainActivity", "Was ineligible: $wasIneligible")
                                    Log.d("MainActivity", "generatedCoupons from viewModel.value: $generatedCoupons")
                                    Log.d("MainActivity", "generatedCoupons count: ${generatedCoupons.size}")

                                    if (wasIneligible) {
                                        // Ineligible participant - go back to main menu
                                        Log.d("MainActivity", "Navigating to menu due to eligibility failure")
                                        navController.navigate(AppDestinations.MENU) {
                                            popUpTo(AppDestinations.MENU) { inclusive = false }
                                        }
                                    } else {
                                        // Normal survey completion - always navigate to staff validation
                                        val couponsParam = if (generatedCoupons.isNotEmpty()) {
                                            generatedCoupons.joinToString(",")
                                        } else {
                                            ""
                                        }

                                        Log.d("MainActivity", "Survey completed - navigating to staff validation with coupons: $couponsParam")
                                        navController.navigate("${AppDestinations.STAFF_VALIDATION}/$innerSurveyId?coupons=$couponsParam") {
                                            popUpTo(AppDestinations.SURVEY_SCREEN) { inclusive = false }
                                        }
                                    }
                                },
                                onNavigateToHivTest = {
                                    // Navigate to HIV Test Staff Validation screen first (deprecated path)
                                    val currentSurveyId = viewModel.survey?.id ?: ""
                                    Log.d("MainActivity", "Navigating to HIV Test Staff Validation after eligibility for survey: $currentSurveyId")
                                    navController.navigate("${AppDestinations.HIV_TEST_STAFF_VALIDATION}/$currentSurveyId") {
                                        // Don't pop the survey screen, we'll return to it after HIV test
                                        launchSingleTop = true
                                    }
                                    // Mark that we've started the HIV test process
                                    viewModel.markHivTestCompleted()
                                },
                                onNavigateToRapidTests = {
                                    // Check if staff eligibility screening is enabled and sample collection timing
                                    val currentSurveyId = viewModel.survey?.id ?: ""
                                    coroutineScope.launch(Dispatchers.IO) {
                                        val surveyConfig = database.surveyConfigDao().getSurveyConfig()
                                        val staffEligibilityScreening = surveyConfig?.staffEligibilityScreening ?: false
                                        val rapidTestSamplesAfterEligibility = surveyConfig?.rapidTestSamplesAfterEligibility ?: true

                                        withContext(Dispatchers.Main) {
                                            if (!rapidTestSamplesAfterEligibility) {
                                                // Samples will be collected at end of survey - show tablet handoff screen
                                                Log.d("MainActivity", "Samples NOT collected after eligibility - navigating to tablet handoff screen")
                                                navController.navigate("${AppDestinations.TABLET_HANDOFF}/$currentSurveyId") {
                                                    launchSingleTop = true
                                                }
                                            } else if (staffEligibilityScreening) {
                                                // Staff already validated during eligibility - skip staff validation screen
                                                Log.d("MainActivity", "Staff eligibility screening enabled - skipping staff validation, going directly to biological sample collection for survey: $currentSurveyId")
                                                navController.navigate("${AppDestinations.BIOLOGICAL_SAMPLE_COLLECTION}/$currentSurveyId") {
                                                    launchSingleTop = true
                                                }
                                            } else {
                                                // Need staff validation before sample collection
                                                Log.d("MainActivity", "Navigating to sample collection staff validation after eligibility for survey: $currentSurveyId")
                                                navController.navigate("${AppDestinations.SAMPLE_COLLECTION_STAFF_VALIDATION}/$currentSurveyId") {
                                                    launchSingleTop = true
                                                }
                                            }
                                        }
                                    }
                                },
                                onNavigateToConsent = { consentSurveyId ->
                                    // Staff screening mode: navigate to consent after eligibility passes
                                    Log.d("MainActivity", "Navigating to consent after eligibility for survey: $consentSurveyId")
                                    navController.navigate("${AppDestinations.CONSENT_INSTRUCTION}/$consentSurveyId?coupons=&returnTo=survey") {
                                        launchSingleTop = true
                                    }
                                }
                            )
                        } else {
                            // Show loading while finding survey
                            Box(
                                modifier = Modifier.fillMaxSize(),
                                contentAlignment = Alignment.Center
                            ) {
                                CircularProgressIndicator()
                            }
                        }
                    }
                    
                    composable(
                        route = AppDestinations.COUPON_ISSUED_SCREEN + "?coupons={coupons}&surveyId={surveyId}",
                        arguments = listOf(
                            androidx.navigation.navArgument("coupons") {
                                type = androidx.navigation.NavType.StringType
                                defaultValue = ""
                            },
                            androidx.navigation.navArgument("surveyId") {
                                type = androidx.navigation.NavType.StringType
                                nullable = true
                                defaultValue = null
                            }
                        )
                    ) { backStackEntry ->
                        val couponsString = backStackEntry.arguments?.getString("coupons") ?: ""
                        val surveyId = backStackEntry.arguments?.getString("surveyId")
                        val coupons = if (couponsString.isNotEmpty()) {
                            couponsString.split(",")
                        } else {
                            emptyList()
                        }
                        com.dev.salt.ui.CouponIssuedScreen(
                            navController = navController,
                            generatedCoupons = coupons,
                            surveyId = surveyId,
                            database = SurveyDatabase.getInstance(this@MainActivity)
                        )
                    }

                    composable(
                        route = AppDestinations.WALKIN_RECRUITMENT_PAYMENT_SCREEN + "/{surveyId}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType }
                        )
                    ) { backStackEntry ->
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        com.dev.salt.ui.WalkInRecruitmentPaymentScreen(
                            navController = navController,
                            surveyId = surveyId,
                            database = SurveyDatabase.getInstance(this@MainActivity)
                        )
                    }

                    composable(
                        route = "${AppDestinations.STAFF_VALIDATION}/{surveyId}?coupons={coupons}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType },
                            navArgument("coupons") {
                                type = NavType.StringType
                                defaultValue = ""
                            }
                        )
                    ) { backStackEntry ->
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        val coupons = backStackEntry.arguments?.getString("coupons") ?: ""
                        val context = LocalContext.current
                        val database = SurveyDatabase.getInstance(context)
                        val scope = rememberCoroutineScope()

                        com.dev.salt.StaffValidationScreen(
                            surveyId = surveyId,
                            onValidationSuccess = {
                                // Check if contact info collection is enabled
                                Log.d("MainActivity", "=== CONTACT INFO DECISION DEBUG ===")
                                scope.launch(Dispatchers.IO) {
                                    Log.d("MainActivity", "Querying survey config from database...")
                                    val surveyConfig = database.surveyConfigDao().getSurveyConfig()
                                    Log.d("MainActivity", "Survey config retrieved: $surveyConfig")
                                    Log.d("MainActivity", "Survey config details: " +
                                        "surveyName=${surveyConfig?.surveyName}, " +
                                        "serverSurveyId=${surveyConfig?.serverSurveyId}, " +
                                        "fingerprintEnabled=${surveyConfig?.fingerprintEnabled}, " +
                                        "contactInfoEnabled=${surveyConfig?.contactInfoEnabled}, " +
                                        "staffEligibilityScreening=${surveyConfig?.staffEligibilityScreening}")

                                    val contactInfoEnabled = surveyConfig?.contactInfoEnabled ?: false
                                    Log.d("MainActivity", "Extracted contactInfoEnabled value: $contactInfoEnabled (raw: ${surveyConfig?.contactInfoEnabled})")

                                    withContext(Dispatchers.Main) {
                                        if (contactInfoEnabled) {
                                            Log.d("MainActivity", "✓ Contact info IS enabled - navigating to CONTACT_CONSENT screen")
                                            // Navigate to contact consent if enabled
                                            navController.navigate("${AppDestinations.CONTACT_CONSENT}/$surveyId?coupons=$coupons")
                                        } else {
                                            Log.d("MainActivity", "✗ Contact info NOT enabled - SKIPPING contact consent screen")
                                            // Skip contact consent - check if tests are enabled
                                            scope.launch(Dispatchers.IO) {
                                                // Get the actual survey ID from sections
                                                val sections = database.sectionDao().getAllSections()
                                                val actualSurveyId = sections.firstOrNull()?.surveyId?.toLong() ?: -1L
                                                val tests = database.testConfigurationDao().getEnabledTestConfigurations(actualSurveyId)
                                                val testsEnabled = tests.size
                                                val rapidTestSamplesAfterEligibility = surveyConfig?.rapidTestSamplesAfterEligibility ?: true

                                                withContext(Dispatchers.Main) {
                                                    if (testsEnabled > 0) {
                                                        if (rapidTestSamplesAfterEligibility) {
                                                            // Samples already collected after eligibility - go directly to rapid test results
                                                            Log.d("MainActivity", "Samples collected after eligibility - navigating to rapid test results")
                                                            navController.navigate("${AppDestinations.RAPID_TEST_RESULT}/$surveyId/0?coupons=$coupons")
                                                        } else {
                                                            // Samples NOT collected after eligibility - need to collect them now
                                                            Log.d("MainActivity", "Samples NOT collected after eligibility - navigating to biological sample collection")
                                                            navController.navigate("${AppDestinations.BIOLOGICAL_SAMPLE_COLLECTION}/$surveyId?coupons=$coupons")
                                                        }
                                                    } else {
                                                        // No tests, go directly to lab collection
                                                        navController.navigate("${AppDestinations.LAB_COLLECTION}/$surveyId?coupons=$coupons")
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            },
                            onCancel = {
                                // Go back to menu or survey completion
                                navController.popBackStack()
                            }
                        )
                    }

                    composable(
                        route = "${AppDestinations.CONSENT_INSTRUCTION}/{surveyId}?coupons={coupons}&returnTo={returnTo}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType },
                            navArgument("coupons") {
                                type = NavType.StringType
                                defaultValue = ""
                            },
                            navArgument("returnTo") {
                                type = NavType.StringType
                                defaultValue = "survey_start"  // Default: go to survey start (self-screening mode)
                            }
                        )
                    ) { backStackEntry ->
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        val coupons = backStackEntry.arguments?.getString("coupons") ?: ""
                        val returnTo = backStackEntry.arguments?.getString("returnTo") ?: "survey_start"
                        com.dev.salt.ui.ConsentInstructionScreen(
                            navController = navController,
                            surveyId = surveyId,
                            coupons = coupons,
                            returnTo = returnTo
                        )
                    }

                    composable(
                        route = "${AppDestinations.CONSENT_SIGNATURE}/{surveyId}?coupons={coupons}&returnTo={returnTo}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType },
                            navArgument("coupons") {
                                type = NavType.StringType
                                defaultValue = ""
                            },
                            navArgument("returnTo") {
                                type = NavType.StringType
                                defaultValue = "survey_start"
                            }
                        )
                    ) { backStackEntry ->
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        val coupons = backStackEntry.arguments?.getString("coupons") ?: ""
                        val returnTo = backStackEntry.arguments?.getString("returnTo") ?: "survey_start"
                        com.dev.salt.ui.ConsentSignatureScreen(
                            navController = navController,
                            surveyId = surveyId,
                            coupons = coupons,
                            returnTo = returnTo
                        )
                    }

                    composable(
                        route = "${AppDestinations.CONTACT_CONSENT}/{surveyId}?coupons={coupons}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType },
                            navArgument("coupons") {
                                type = NavType.StringType
                                defaultValue = ""
                            }
                        )
                    ) { backStackEntry ->
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        val coupons = backStackEntry.arguments?.getString("coupons") ?: ""
                        com.dev.salt.ui.ContactConsentScreen(
                            navController = navController,
                            surveyId = surveyId,
                            coupons = coupons
                        )
                    }
                    
                    composable(
                        route = "${AppDestinations.CONTACT_INFO}/{surveyId}?coupons={coupons}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType },
                            navArgument("coupons") { 
                                type = NavType.StringType
                                defaultValue = ""
                            }
                        )
                    ) { backStackEntry ->
                        val context: Context = LocalContext.current
                        val database = SurveyDatabase.getInstance(context)
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        val coupons = backStackEntry.arguments?.getString("coupons") ?: ""
                        com.dev.salt.ui.ContactInfoScreen(
                            navController = navController,
                            database = database,
                            surveyId = surveyId,
                            coupons = coupons
                        )
                    }
                    
                    composable(AppDestinations.SERVER_SETTINGS_SCREEN) {
                        ServerSettingsScreen(
                            onBack = { navController.popBackStack() },
                            onNavigateToSetup = {
                                navController.navigate("${AppDestinations.FACILITY_SETUP}?showCancel=true")
                            }
                        )
                    }

                    composable(AppDestinations.LANGUAGE_SETTINGS) {
                        LanguageSettingsScreen(navController = navController)
                    }

                    composable(AppDestinations.DEVELOPER_SETTINGS) {
                        DeveloperSettingsScreen(navController = navController)
                    }

                    composable(AppDestinations.COUPON_LOGGING) {
                        com.dev.salt.ui.CouponLoggingScreen(navController = navController)
                    }

                    composable(
                        route = "${AppDestinations.STAFF_FINGERPRINT_ENROLLMENT}/{userName}",
                        arguments = listOf(
                            navArgument("userName") { type = NavType.StringType }
                        )
                    ) { backStackEntry ->
                        val userName = backStackEntry.arguments?.getString("userName") ?: ""
                        StaffFingerprintEnrollmentScreen(
                            navController = navController,
                            userName = userName
                        )
                    }

                    composable(AppDestinations.UPLOAD_STATUS_SCREEN) {
                        UploadStatusScreen(
                            onBack = { navController.popBackStack() }
                        )
                    }
                    
                    composable(AppDestinations.SEED_RECRUITMENT) {
                        com.dev.salt.ui.SeedRecruitmentScreen(
                            navController = navController
                        )
                    }
                    
                    composable(
                        route = "${AppDestinations.LAB_COLLECTION}/{surveyId}?coupons={coupons}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType },
                            navArgument("coupons") {
                                type = NavType.StringType
                                nullable = true
                                defaultValue = ""
                            }
                        )
                    ) { backStackEntry ->
                        val context = LocalContext.current
                        val database = SurveyDatabase.getInstance(context)
                        val scope = rememberCoroutineScope()
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        val coupons = backStackEntry.arguments?.getString("coupons") ?: ""

                        // Get the survey to get subject ID
                        var subjectId by remember { mutableStateOf<String?>(null) }
                        LaunchedEffect(surveyId) {
                            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                                val survey = database.surveyDao().getSurveyById(surveyId)
                                subjectId = survey?.subjectId ?: ""
                                Log.d("MainActivity", "Lab Collection - Survey ID: $surveyId, Subject ID: $subjectId")
                            }
                        }

                        when (subjectId) {
                            null -> {
                                // Loading state
                                Box(
                                    modifier = Modifier.fillMaxSize(),
                                    contentAlignment = Alignment.Center
                                ) {
                                    CircularProgressIndicator()
                                }
                            }
                            "" -> {
                                // Error state - survey not found
                                Box(
                                    modifier = Modifier.fillMaxSize(),
                                    contentAlignment = Alignment.Center
                                ) {
                                    Text(stringResource(R.string.survey_error_not_found), color = androidx.compose.ui.graphics.Color.Red)
                                }
                            }
                            else -> {
                                // Show the lab collection screen
                                com.dev.salt.ui.LabCollectionScreen(
                                    surveyId = surveyId,
                                    subjectId = subjectId!!,
                                    onSamplesCollected = {
                                        // Update survey to record samples were collected, then navigate
                                        scope.launch {
                                            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                                                val survey = database.surveyDao().getSurveyById(surveyId)
                                                if (survey != null) {
                                                    val updatedSurvey = survey.copy(sampleCollected = true)
                                                    database.surveyDao().updateSurvey(updatedSurvey)
                                                    Log.d("MainActivity", "Updated survey $surveyId: sampleCollected = true")
                                                }
                                            }
                                            // Navigate to coupon issued screen after database update completes
                                            Log.d("MainActivity", "=== LAB_COLLECTION -> COUPON_ISSUED Navigation ===")
                                            Log.d("MainActivity", "coupons parameter: '$coupons'")
                                            Log.d("MainActivity", "surveyId: $surveyId")
                                            navController.navigate("${AppDestinations.COUPON_ISSUED}?coupons=$coupons&surveyId=$surveyId")
                                        }
                                    },
                                    onCancel = {
                                        // Update survey to record samples were refused, then navigate
                                        scope.launch {
                                            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                                                val survey = database.surveyDao().getSurveyById(surveyId)
                                                if (survey != null) {
                                                    val updatedSurvey = survey.copy(sampleCollected = false)
                                                    database.surveyDao().updateSurvey(updatedSurvey)
                                                    Log.d("MainActivity", "Updated survey $surveyId: sampleCollected = false")
                                                }
                                            }
                                            // Navigate to coupon issued screen after database update completes
                                            navController.navigate("${AppDestinations.COUPON_ISSUED}?coupons=$coupons&surveyId=$surveyId")
                                        }
                                    },
                                    onBack = {
                                        // Navigate back to previous screen
                                        navController.navigateUp()
                                    }
                                )
                            }
                        }
                    }

                    composable(
                        route = "${AppDestinations.FINGERPRINT_SCREENING}/{surveyId}?couponCode={couponCode}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType },
                            navArgument("couponCode") {
                                type = NavType.StringType
                                nullable = true
                                defaultValue = null
                            }
                        )
                    ) { backStackEntry ->
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        val couponCode = backStackEntry.arguments?.getString("couponCode")
                        com.dev.salt.ui.FingerprintScreeningScreen(
                            navController = navController,
                            surveyId = surveyId,
                            couponCode = couponCode
                        )
                    }

                    // Recruitment Payment screens
                    composable(AppDestinations.RECRUITMENT_LOOKUP) {
                        com.dev.salt.ui.RecruitmentLookupScreen(
                            navController = navController
                        )
                    }

                    composable(
                        route = "${AppDestinations.RECRUITMENT_PAYMENT}/{surveyId}?lookupMethod={lookupMethod}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType },
                            navArgument("lookupMethod") {
                                type = NavType.StringType
                                defaultValue = "coupon_admin_override"
                            }
                        )
                    ) { backStackEntry ->
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        val lookupMethod = backStackEntry.arguments?.getString("lookupMethod") ?: "coupon_admin_override"
                        com.dev.salt.ui.RecruitmentPaymentScreen(
                            navController = navController,
                            surveyId = surveyId,
                            lookupMethod = lookupMethod
                        )
                    }

                    composable(
                        route = "${AppDestinations.MANUAL_DUPLICATE_CHECK}/{surveyId}?couponCode={couponCode}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType },
                            navArgument("couponCode") {
                                type = NavType.StringType
                                nullable = true
                                defaultValue = null
                            }
                        )
                    ) { backStackEntry ->
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        val couponCode = backStackEntry.arguments?.getString("couponCode") ?: ""
                        val context: Context = LocalContext.current
                        val database = SurveyDatabase.getInstance(context)
                        com.dev.salt.ui.ManualDuplicateCheckScreen(
                            navController = navController,
                            database = database,
                            surveyId = surveyId,
                            couponCode = couponCode
                        )
                    }

                    composable(
                        route = "${AppDestinations.LANGUAGE_SELECTION}/{surveyId}?couponCode={couponCode}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType },
                            navArgument("couponCode") { 
                                type = NavType.StringType
                                nullable = true
                                defaultValue = null
                            }
                        )
                    ) { backStackEntry ->
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        val couponCode = backStackEntry.arguments?.getString("couponCode")
                        com.dev.salt.ui.LanguageSelectionScreen(
                            navController = navController,
                            surveyId = surveyId,
                            couponCode = couponCode
                        )
                    }

                    composable(
                        route = "${AppDestinations.STAFF_INSTRUCTION}/{surveyId}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType }
                        )
                    ) { backStackEntry ->
                        val context = LocalContext.current
                        val database = SurveyDatabase.getInstance(context)
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        val scope = rememberCoroutineScope()

                        com.dev.salt.ui.StaffInstructionScreen(
                            navController = navController,
                            surveyId = surveyId,
                            onContinue = {
                                scope.launch {
                                    // Retrieve the coupon code from the survey entity
                                    val survey = withContext(Dispatchers.IO) {
                                        database.surveyDao().getSurveyById(surveyId)
                                    }
                                    val couponCode = survey?.referralCouponCode ?: ""

                                    // Navigate to the survey screen with the surveyId and couponCode
                                    navController.navigate("${AppDestinations.SURVEY}?couponCode=$couponCode&surveyId=$surveyId") {
                                        popUpTo(AppDestinations.STAFF_INSTRUCTION) { inclusive = true }
                                    }
                                }
                            }
                        )
                    }

                    composable(
                        route = "${AppDestinations.SUBJECT_PAYMENT}/{surveyId}?coupons={coupons}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType },
                            navArgument("coupons") {
                                type = NavType.StringType
                                nullable = true
                                defaultValue = ""
                            }
                        )
                    ) { backStackEntry ->
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        val coupons = backStackEntry.arguments?.getString("coupons") ?: ""
                        com.dev.salt.ui.SubjectPaymentScreen(
                            navController = navController,
                            surveyId = surveyId,
                            coupons = coupons
                        )
                    }

                    composable(
                        route = "${AppDestinations.HIV_TEST_STAFF_VALIDATION}/{surveyId}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType }
                        )
                    ) { backStackEntry ->
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        com.dev.salt.ui.HIVTestStaffValidationScreen(
                            navController = navController,
                            surveyId = surveyId
                        )
                    }

                    composable(
                        route = "${AppDestinations.HAND_TABLET_BACK}/{surveyId}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType }
                        )
                    ) { backStackEntry ->
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        com.dev.salt.ui.HandTabletBackScreen(
                            navController = navController,
                            surveyId = surveyId
                        )
                    }

                    composable(
                        route = "${AppDestinations.HIV_TEST_INSTRUCTION}/{surveyId}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType }
                        )
                    ) { backStackEntry ->
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        com.dev.salt.ui.HIVRapidTestInstructionScreen(
                            surveyId = surveyId,
                            onStaffValidated = {
                                // Navigate to the Hand Tablet Back screen after HIV test instruction
                                navController.navigate("${AppDestinations.HAND_TABLET_BACK}/$surveyId") {
                                    popUpTo("${AppDestinations.HIV_TEST_INSTRUCTION}/$surveyId") { inclusive = true }
                                }
                            },
                            onCancel = {
                                // Go back to menu if cancelled
                                navController.navigate(AppDestinations.MENU_SCREEN) {
                                    popUpTo(AppDestinations.HIV_TEST_INSTRUCTION) { inclusive = true }
                                }
                            }
                        )
                    }

                    composable(
                        route = "${AppDestinations.HIV_TEST_RESULT}/{surveyId}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType }
                        )
                    ) { backStackEntry ->
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        val context = LocalContext.current
                        val database = SurveyDatabase.getInstance(context)
                        val scope = rememberCoroutineScope()

                        // Get coupons from the survey for later navigation
                        var coupons by remember { mutableStateOf("") }
                        LaunchedEffect(surveyId) {
                            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                                val survey = database.surveyDao().getSurveyById(surveyId)
                                val existingCoupons = database.couponDao().getCouponsIssuedToSurvey(surveyId)
                                if (existingCoupons.isNotEmpty()) {
                                    coupons = existingCoupons.joinToString(",") { it.couponCode }
                                }
                            }
                        }

                        com.dev.salt.ui.HIVRapidTestResultScreen(
                            surveyId = surveyId,
                            onResultSubmitted = {
                                // After test result is submitted, navigate to payment
                                navController.navigate("${AppDestinations.SUBJECT_PAYMENT}/$surveyId?coupons=$coupons")
                            },
                            onCancel = {
                                // Go back to menu if cancelled
                                navController.navigate(AppDestinations.MENU_SCREEN) {
                                    popUpTo(AppDestinations.HIV_TEST_RESULT) { inclusive = true }
                                }
                            }
                        )
                    }

                    // Sample Collection Staff Validation (after eligibility)
                    composable(
                        route = "${AppDestinations.SAMPLE_COLLECTION_STAFF_VALIDATION}/{surveyId}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType }
                        )
                    ) { backStackEntry ->
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        StaffValidationScreen(
                            surveyId = surveyId,
                            onValidationSuccess = {
                                // Navigate to biological sample collection screen
                                navController.navigate("${AppDestinations.BIOLOGICAL_SAMPLE_COLLECTION}/$surveyId") {
                                    popUpTo("${AppDestinations.SAMPLE_COLLECTION_STAFF_VALIDATION}/$surveyId") { inclusive = true }
                                }
                            },
                            onCancel = {
                                navController.navigate(AppDestinations.MENU_SCREEN) {
                                    popUpTo(AppDestinations.SAMPLE_COLLECTION_STAFF_VALIDATION) { inclusive = true }
                                }
                            }
                        )
                    }

                    // Biological Sample Collection Confirmation
                    composable(
                        route = "${AppDestinations.BIOLOGICAL_SAMPLE_COLLECTION}/{surveyId}?coupons={coupons}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType },
                            navArgument("coupons") {
                                type = NavType.StringType
                                defaultValue = ""
                            }
                        )
                    ) { backStackEntry ->
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        val coupons = backStackEntry.arguments?.getString("coupons") ?: ""
                        val context: Context = LocalContext.current
                        val database = SurveyDatabase.getInstance(context)
                        val scope = rememberCoroutineScope()

                        // Get the existing survey viewmodel from the shared map
                        val surveyViewModel: SurveyViewModel? = surveyViewModels[surveyId]

                        com.dev.salt.ui.BiologicalSampleCollectionScreen(
                            surveyId = surveyId,
                            onSamplesConfirmed = {
                                // Check if rapid test samples are after eligibility to determine next screen
                                scope.launch(Dispatchers.IO) {
                                    val surveyConfig = database.surveyConfigDao().getSurveyConfig()
                                    val rapidTestSamplesAfterEligibility = surveyConfig?.rapidTestSamplesAfterEligibility ?: true

                                    withContext(Dispatchers.Main) {
                                        if (rapidTestSamplesAfterEligibility) {
                                            // Normal flow after eligibility - navigate to tablet handoff screen
                                            Log.d("MainActivity", "Samples collected after eligibility - navigating to tablet handoff")
                                            navController.navigate("${AppDestinations.TABLET_HANDOFF}/$surveyId") {
                                                popUpTo(AppDestinations.BIOLOGICAL_SAMPLE_COLLECTION) { inclusive = true }
                                            }
                                        } else {
                                            // Samples collected at end of survey - navigate to rapid test results with coupons
                                            Log.d("MainActivity", "Samples collected at end of survey - navigating to rapid test results")
                                            navController.navigate("${AppDestinations.RAPID_TEST_RESULT}/$surveyId/0?coupons=$coupons") {
                                                popUpTo(AppDestinations.BIOLOGICAL_SAMPLE_COLLECTION) { inclusive = true }
                                            }
                                        }
                                    }
                                }
                            },
                            onCancel = {
                                navController.navigate(AppDestinations.MENU_SCREEN) {
                                    popUpTo(AppDestinations.BIOLOGICAL_SAMPLE_COLLECTION) { inclusive = true }
                                }
                            }
                        )
                    }

                    // Tablet Handoff Screen - shown after biological sample collection
                    composable(
                        route = "${AppDestinations.TABLET_HANDOFF}/{surveyId}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType }
                        )
                    ) { backStackEntry ->
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""

                        // Get the existing survey viewmodel from the shared map
                        val surveyViewModel: SurveyViewModel? = surveyViewModels[surveyId]

                        com.dev.salt.ui.TabletHandoffScreen(
                            navController = navController,
                            surveyId = surveyId,
                            onContinue = {
                                // Mark rapid tests as completed and advance to question
                                surveyViewModel?.let { vm ->
                                    vm.markRapidTestsCompleted()
                                    vm.jumpToQuestion(vm.getTheCurrentQuestionIndex())
                                    Log.d("MainActivity", "Tablet handed off, marked rapid tests handled and advancing to question ${vm.getTheCurrentQuestionIndex()}")
                                }

                                // Check if we need to pop twice (after biological sample collection) or once (direct from survey)
                                // We came from biological sample collection if rapidTestSamplesAfterEligibility is true
                                val context = navController.context
                                val database = SurveyDatabase.getInstance(context)
                                val surveyConfig = database.surveyConfigDao().getSurveyConfig()
                                val rapidTestSamplesAfterEligibility = surveyConfig?.rapidTestSamplesAfterEligibility ?: true

                                if (rapidTestSamplesAfterEligibility) {
                                    // Pop twice: tablet handoff + biological sample collection
                                    Log.d("MainActivity", "Popping twice (tablet handoff + biological sample collection)")
                                    navController.popBackStack()
                                    navController.popBackStack()
                                } else {
                                    // Pop once: just tablet handoff
                                    Log.d("MainActivity", "Popping once (just tablet handoff)")
                                    navController.popBackStack()
                                }
                            }
                        )
                    }

                    // New: Generic Rapid Test Instruction Screen (DEPRECATED - not used in new flow)
                    composable(
                        route = "${AppDestinations.RAPID_TEST_INSTRUCTION}/{surveyId}/{testIndex}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType },
                            navArgument("testIndex") { type = NavType.IntType }
                        )
                    ) { backStackEntry ->
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        val testIndex = backStackEntry.arguments?.getInt("testIndex") ?: 0
                        val context = LocalContext.current
                        val database = SurveyDatabase.getInstance(context)
                        val testManagementViewModel: com.dev.salt.viewmodels.TestManagementViewModel = viewModel()

                        // Load enabled tests
                        LaunchedEffect(Unit) {
                            val sections = database.sectionDao().getAllSections()
                            val actualSurveyId = sections.firstOrNull()?.surveyId?.toLong() ?: -1L

                            if (actualSurveyId == -1L) {
                                android.util.Log.e("MainActivity", "CRITICAL ERROR: No sections found in database - survey not properly synced!")
                            }

                            testManagementViewModel.loadEnabledTests(actualSurveyId)
                        }

                        val enabledTests by testManagementViewModel.enabledTests.collectAsState()
                        val currentTest = enabledTests.getOrNull(testIndex)

                        if (currentTest != null) {
                            com.dev.salt.ui.RapidTestInstructionScreen(
                                surveyId = surveyId,
                                testId = currentTest.testId,
                                testName = currentTest.testName,
                                onStaffValidated = {
                                    // Navigate to result entry for this test
                                    navController.navigate("${AppDestinations.RAPID_TEST_RESULT}/$surveyId/$testIndex") {
                                        popUpTo("${AppDestinations.RAPID_TEST_INSTRUCTION}/$surveyId/$testIndex") { inclusive = true }
                                    }
                                },
                                onCancel = {
                                    navController.navigate(AppDestinations.MENU_SCREEN) {
                                        popUpTo(AppDestinations.RAPID_TEST_INSTRUCTION) { inclusive = true }
                                    }
                                }
                            )
                        } else {
                            // No test at this index - shouldn't happen, but handle gracefully
                            Box(
                                modifier = Modifier.fillMaxSize(),
                                contentAlignment = Alignment.Center
                            ) {
                                Text("Error: Test not found")
                            }
                        }
                    }

                    // New: Generic Rapid Test Result Screen
                    composable(
                        route = "${AppDestinations.RAPID_TEST_RESULT}/{surveyId}/{testIndex}?coupons={coupons}",
                        arguments = listOf(
                            navArgument("surveyId") { type = NavType.StringType },
                            navArgument("testIndex") { type = NavType.IntType },
                            navArgument("coupons") {
                                type = NavType.StringType
                                defaultValue = ""
                            }
                        )
                    ) { backStackEntry ->
                        val surveyId = backStackEntry.arguments?.getString("surveyId") ?: ""
                        val testIndex = backStackEntry.arguments?.getInt("testIndex") ?: 0
                        val couponsParam = backStackEntry.arguments?.getString("coupons") ?: ""
                        val context = LocalContext.current
                        val database = SurveyDatabase.getInstance(context)
                        val testManagementViewModel: com.dev.salt.viewmodels.TestManagementViewModel = viewModel()
                        val scope = rememberCoroutineScope()

                        // Load enabled tests
                        LaunchedEffect(Unit) {
                            val sections = database.sectionDao().getAllSections()
                            val actualSurveyId = sections.firstOrNull()?.surveyId?.toLong() ?: -1L

                            if (actualSurveyId == -1L) {
                                android.util.Log.e("MainActivity", "CRITICAL ERROR: No sections found in database - survey not properly synced!")
                            }

                            testManagementViewModel.loadEnabledTests(actualSurveyId)
                        }

                        val enabledTests by testManagementViewModel.enabledTests.collectAsState()
                        val currentTest = enabledTests.getOrNull(testIndex)

                        if (currentTest != null) {
                            com.dev.salt.ui.RapidTestResultScreen(
                                surveyId = surveyId,
                                testId = currentTest.testId,
                                testName = currentTest.testName,
                                onResultSubmitted = {
                                    // Check if there are more tests
                                    val nextTestIndex = testIndex + 1
                                    if (nextTestIndex < enabledTests.size) {
                                        // Navigate to next test result entry (skip instruction screen)
                                        Log.d("MainActivity", "Moving to next test result: $nextTestIndex/${enabledTests.size}")
                                        navController.navigate("${AppDestinations.RAPID_TEST_RESULT}/$surveyId/$nextTestIndex?coupons=$couponsParam") {
                                            popUpTo("${AppDestinations.RAPID_TEST_RESULT}/$surveyId/$testIndex") { inclusive = true }
                                        }
                                    } else {
                                        // All tests completed - navigate to lab collection
                                        Log.d("MainActivity", "All rapid tests completed, navigating to lab collection")
                                        navController.navigate("${AppDestinations.LAB_COLLECTION}/$surveyId?coupons=$couponsParam")
                                    }
                                },
                                onBack = {
                                    // Navigate back to previous test or previous screen
                                    if (testIndex > 0) {
                                        // Go to previous test
                                        val prevTestIndex = testIndex - 1
                                        Log.d("MainActivity", "Going back to previous test: $prevTestIndex")
                                        navController.navigate("${AppDestinations.RAPID_TEST_RESULT}/$surveyId/$prevTestIndex?coupons=$couponsParam") {
                                            popUpTo("${AppDestinations.RAPID_TEST_RESULT}/$surveyId/$testIndex") { inclusive = true }
                                        }
                                    } else {
                                        // First test, go back to previous screen
                                        navController.navigateUp()
                                    }
                                }
                            )
                        } else {
                            // No test at this index
                            Box(
                                modifier = Modifier.fillMaxSize(),
                                contentAlignment = Alignment.Center
                            ) {
                                Text("Error: Test not found")
                            }
                        }
                    }

                    // Add other composables for your survey, admin dashboard, etc.
                    }
                }
            }
        }
    }
}

// --- Placeholder Screen Composables ---
// If these are not in separate files, define them here or import them.

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WelcomeScreen(navController: NavHostController) {
    val context = LocalContext.current
    val database = remember { SurveyDatabase.getInstance(context) }
    val scope = rememberCoroutineScope()
    var isValidating by remember { mutableStateOf(false) }

    // Get app version info
    val versionInfo = remember {
        try {
            val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            val versionName = packageInfo.versionName ?: "?"
            val versionCode = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                packageInfo.longVersionCode
            } else {
                @Suppress("DEPRECATION")
                packageInfo.versionCode.toLong()
            }
            "v$versionName-$versionCode"
        } catch (e: Exception) {
            ""
        }
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text(stringResource(R.string.app_title_welcome)) }) }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(16.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(stringResource(R.string.menu_welcome), style = MaterialTheme.typography.headlineMedium)
            if (versionInfo.isNotEmpty()) {
                Text(
                    text = versionInfo,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp)
                )
            }
            Spacer(modifier = Modifier.height(32.dp))

            if (isValidating) {
                CircularProgressIndicator()
                Text("Validating connection...", modifier = Modifier.padding(top = 8.dp))
            } else {
                Button(onClick = {
                    // Validate API key before navigating
                    isValidating = true
                    scope.launch {
                        val configSyncManager = com.dev.salt.sync.FacilityConfigSyncManager(database)
                        val isValid = configSyncManager.validateApiKey(context)

                        isValidating = false

                        if (!isValid) {
                            // API key is invalid, navigate to setup
                            Log.d("WelcomeScreen", "API key validation failed, navigating to facility setup")
                            navController.navigate("${AppDestinations.FACILITY_SETUP}?showCancel=false") {
                                popUpTo(AppDestinations.WELCOME_SCREEN) { inclusive = true }
                            }
                        } else {
                            // API key is valid or couldn't be verified (network error), proceed to login
                            navController.navigate(AppDestinations.LOGIN_SCREEN)
                        }
                    }
                }) {
                    Text(stringResource(R.string.login_button_login))
                }
            }
            // You can add other buttons like "Register" or "Continue as Guest" if needed
        }
    }
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun MenuScreen(
    navController: NavHostController,
    onLogout: () -> Unit,
    showLogout: Boolean = true,
    syncMessage: SyncMessage? = null,
    onSyncMessageDismissed: () -> Unit = {}
) {
    val context = LocalContext.current
    val database = remember { SurveyDatabase.getInstance(context) }
    val recruitmentManager = remember { com.dev.salt.util.SeedRecruitmentManager(database) }
    val scope = rememberCoroutineScope()
    var showSeedRecruitment by remember { mutableStateOf(false) }
    var showRecruitmentPayment by remember { mutableStateOf(false) }
    var quotaStatus by remember { mutableStateOf<com.dev.salt.util.EnrollmentQuota.Status?>(null) }

    // Disable hardware back button on menu screen
    BackHandler(enabled = true) {
        // Intentionally empty - back button is disabled on menu screen
    }

    // Snackbar host state for sync messages
    val snackbarHostState = remember { androidx.compose.material3.SnackbarHostState() }

    // Show sync message as snackbar when it arrives
    LaunchedEffect(syncMessage) {
        syncMessage?.let { msg ->
            snackbarHostState.showSnackbar(
                message = msg.message,
                duration = androidx.compose.material3.SnackbarDuration.Short
            )
            onSyncMessageDismissed()
        }
    }

    // Check if seed recruitment and recruitment payment are allowed
    LaunchedEffect(navController.currentBackStackEntry) {
        Log.d("MenuScreen", "Checking seed recruitment availability...")
        showSeedRecruitment = recruitmentManager.isRecruitmentAllowed()
        Log.d("MenuScreen", "Show seed recruitment button: $showSeedRecruitment")

        // Check if recruitment payment is enabled (amount > 0)
        val facilityConfig = database.facilityConfigDao().getFacilityConfig()
        showRecruitmentPayment = (facilityConfig?.recruitmentPaymentAmount ?: 0.0) > 0
        Log.d("MenuScreen", "Show recruitment payment button: $showRecruitmentPayment (amount=${facilityConfig?.recruitmentPaymentAmount})")

        // Enrollment quota: blocks new surveys (walk-ins and coupon holders) once reached
        quotaStatus = com.dev.salt.util.EnrollmentQuota.load(database)
        Log.d("MenuScreen", "Enrollment quota status: $quotaStatus")
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.menu_staff_title)) },
                actions = {
                    LogoutButton(
                        onLogout = onLogout,
                        isVisible = showLogout
                    )
                }
            )
        },
        snackbarHost = {
            androidx.compose.material3.SnackbarHost(hostState = snackbarHostState) { data ->
                // Custom snackbar with error styling if isError
                val isError = syncMessage?.isError == true
                androidx.compose.material3.Snackbar(
                    snackbarData = data,
                    containerColor = if (isError) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.inverseSurface,
                    contentColor = if (isError) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.inverseOnSurface
                )
            }
        }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            Text(stringResource(R.string.menu_staff_area), style = MaterialTheme.typography.headlineMedium)
            Spacer(modifier = Modifier.height(16.dp))

            val quota = quotaStatus
            if (quota != null && quota.isLimited) {
                Text(
                    text = stringResource(R.string.menu_enrollment_progress, quota.enrolled, quota.quota ?: 0),
                    style = MaterialTheme.typography.bodyLarge
                )
                Spacer(modifier = Modifier.height(8.dp))
            }
            if (quota != null && quota.isReached) {
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 8.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer
                    )
                ) {
                    Text(
                        text = stringResource(R.string.quota_reached_message, quota.quota ?: 0),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onErrorContainer,
                        modifier = Modifier.padding(16.dp)
                    )
                }
            }
            Button(
                onClick = {
                    navController.navigate(AppDestinations.COUPON_SCREEN)
                },
                // Disabled until the quota is known, and once it is reached
                enabled = quota != null && !quota.isReached,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(stringResource(R.string.menu_start_survey))
            }

            // Show seed recruitment button if allowed
            if (showSeedRecruitment) {
                Spacer(modifier = Modifier.height(16.dp))
                Button(
                    onClick = {
                        navController.navigate(AppDestinations.SEED_RECRUITMENT)
                    },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(stringResource(R.string.menu_recruit_participant))
                }
            }

            // Show recruitment payment button if enabled
            if (showRecruitmentPayment) {
                Spacer(modifier = Modifier.height(16.dp))
                Button(
                    onClick = {
                        navController.navigate(AppDestinations.RECRUITMENT_LOOKUP)
                    },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(stringResource(R.string.menu_recruitment_payment))
                }
            }
            // Add other menu items
        }
    }
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun AdminDashboardScreen(
    navController: NavHostController,
    onLogout: () -> Unit,
    showLogout: Boolean = true,
    syncMessage: SyncMessage? = null,
    onSyncMessageDismissed: () -> Unit = {}
) {
    val context = LocalContext.current
    val database = remember { SurveyDatabase.getInstance(context) }
    var hasStaffUsers by remember { mutableStateOf(true) }

    // Snackbar host state for sync messages
    val snackbarHostState = remember { androidx.compose.material3.SnackbarHostState() }

    // Show sync message as snackbar when it arrives
    LaunchedEffect(syncMessage) {
        syncMessage?.let { msg ->
            snackbarHostState.showSnackbar(
                message = msg.message,
                duration = androidx.compose.material3.SnackbarDuration.Short
            )
            onSyncMessageDismissed()
        }
    }

    LaunchedEffect(Unit) {
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            val staffUsers = database.userDao().getAllUsers().filter { it.role == "SURVEY_STAFF" }
            hasStaffUsers = staffUsers.isNotEmpty()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.menu_admin_title)) },
                actions = {
                    LogoutButton(
                        onLogout = onLogout,
                        isVisible = showLogout
                    )
                }
            )
        },
        snackbarHost = {
            androidx.compose.material3.SnackbarHost(hostState = snackbarHostState) { data ->
                // Custom snackbar with error styling if isError
                val isError = syncMessage?.isError == true
                androidx.compose.material3.Snackbar(
                    snackbarData = data,
                    containerColor = if (isError) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.inverseSurface,
                    contentColor = if (isError) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.inverseOnSurface
                )
            }
        }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            Text(stringResource(R.string.menu_admin_area), style = MaterialTheme.typography.headlineMedium)
            Spacer(modifier = Modifier.height(16.dp))

            // Show message if no staff users exist
            if (!hasStaffUsers) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.secondaryContainer
                    )
                ) {
                    Text(
                        text = stringResource(R.string.note_no_staff_users),
                        modifier = Modifier.padding(16.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSecondaryContainer
                    )
                }
                Spacer(modifier = Modifier.height(16.dp))
            }

            Button(
                onClick = { navController.navigate(AppDestinations.USER_MANAGEMENT_SCREEN) },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(stringResource(R.string.menu_manage_users))
            }
            Spacer(modifier = Modifier.height(16.dp))
            Button(
                onClick = { navController.navigate(AppDestinations.SERVER_SETTINGS_SCREEN) },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(stringResource(R.string.menu_server_settings))
            }
            Spacer(modifier = Modifier.height(16.dp))
            Button(
                onClick = { navController.navigate(AppDestinations.UPLOAD_STATUS_SCREEN) },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(stringResource(R.string.menu_upload_status))
            }
            Spacer(modifier = Modifier.height(16.dp))
            Button(
                onClick = { navController.navigate(AppDestinations.LANGUAGE_SETTINGS) },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(stringResource(R.string.language_settings_title))
            }
            Spacer(modifier = Modifier.height(16.dp))
            Button(
                onClick = { navController.navigate(AppDestinations.COUPON_LOGGING) },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(stringResource(R.string.coupon_log_title))
            }
            Spacer(modifier = Modifier.height(16.dp))
            Button(
                onClick = { navController.navigate(AppDestinations.DEVELOPER_SETTINGS) },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(stringResource(R.string.dev_settings_title))
            }
            // Add other admin functions
        }
    }
}

