plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "online.knowmad.harmony.push"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    // Data messages only. Without google-services.json FirebaseApp never initializes and
    // FCM reports itself unavailable.
    implementation("com.google.firebase:firebase-messaging:25.1.3")
    // Web Push decryption (RFC 8291) and distributor handshake for UnifiedPush.
    implementation("org.unifiedpush.android:connector:3.3.5")
    implementation(project(":tauri-android"))

    testImplementation("junit:junit:4.13.2")
    // The connector's decryptor, compiled against in tests; a runtime dependency otherwise.
    testImplementation("com.google.crypto.tink:tink:1.23.0")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.test:core:1.6.1")
}
