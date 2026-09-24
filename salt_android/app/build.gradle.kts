import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.ksp)
}

// Load signing properties from signing.properties file (not in git)
val signingPropertiesFile = rootProject.file("signing.properties")
val signingProperties = Properties()
if (signingPropertiesFile.exists()) {
    signingProperties.load(signingPropertiesFile.inputStream())
}

android {
    namespace = "com.dev.salt"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.dev.salt"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "1.3"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // KSP configuration for Room schema export
    ksp {
        arg("room.schemaLocation", "$projectDir/schemas")
    }

    signingConfigs {
        create("release") {
            storeFile = file(signingProperties.getProperty("SALT_RELEASE_STORE_FILE") ?: "salt-release-key.jks")
            storePassword = signingProperties.getProperty("SALT_RELEASE_STORE_PASSWORD") ?: ""
            keyAlias = signingProperties.getProperty("SALT_RELEASE_KEY_ALIAS") ?: "salt"
            keyPassword = signingProperties.getProperty("SALT_RELEASE_KEY_PASSWORD") ?: ""
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions {
        jvmTarget = "11"
    }
    buildFeatures {
        //viewBinding = true
        compose = true
        buildConfig = true
    }
    lint {
        // Calls to APIs newer than minSdk only fail at runtime (NoSuchMethodError) on
        // older devices, so treat them as fatal: lintVital then blocks every release build.
        fatal += "NewApi"
        abortOnError = true
        checkReleaseBuilds = true
    }
}

dependencies {
    // SecuGen SDK
    implementation(fileTree(mapOf("dir" to "libs", "include" to listOf("*.jar"))))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.material)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.navigation.fragment.ktx)
    implementation(libs.androidx.navigation.ui.ktx)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)

    val room_version = "2.6.1"

    implementation("androidx.room:room-runtime:$room_version")
    // To use Kotlin Symbol Processing (KSP)
    ksp("androidx.room:room-compiler:$room_version")
    // optional - Kotlin Extensions and Coroutines support for Room
    implementation("androidx.room:room-ktx:$room_version")
    
    // SQLCipher for database encryption
    implementation("net.zetetic:android-database-sqlcipher:4.5.4")
    implementation("androidx.sqlite:sqlite-ktx:2.4.0")


    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    // Choose one of the following:
    // Material Design 3
    implementation("androidx.compose.material3:material3")
    // or Material Design 2
    implementation("androidx.compose.material:material")
    // or skip Material Design and build directly on top of foundational components
    implementation("androidx.compose.foundation:foundation")
    // or only import the main APIs for the underlying toolkit systems,
    // such as input and measurement/layout
    implementation("androidx.compose.ui:ui")

    implementation(platform("androidx.compose:compose-bom:2025.06.01")) // Or your BOM version
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.navigation:navigation-compose:2.9.0")

    // Android Studio Preview support
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // UI Tests
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")

    implementation("androidx.activity:activity-compose")


    implementation("androidx.lifecycle:lifecycle-viewmodel-compose")

    implementation("androidx.preference:preference-ktx:1.2.1")

    implementation("androidx.compose.material:material-icons-extended")

    implementation("org.apache.commons:commons-jexl3:3.3")

    // WorkManager for background upload retries
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    // Signature capture for consent (sain library)
    implementation("io.github.joelkanyi:sain:2.1.3")

    // Markdown rendering for question/info/option text (Compose-native, no AndroidView).
    // 0.37.0 is built against Kotlin 2.2.20 to match this project's Compose compiler.
    implementation("com.mikepenz:multiplatform-markdown-renderer-android:0.37.0")
    implementation("com.mikepenz:multiplatform-markdown-renderer-m3-android:0.37.0")
}