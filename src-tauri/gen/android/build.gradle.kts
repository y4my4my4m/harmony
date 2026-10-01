buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        // 2.1 reads the Kotlin 2.2 metadata of the UnifiedPush connector; 2.2 turns the
        // kotlinOptions DSL in tauri-android's build script into an error.
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.1.21")
        // Applied by app/ only when google-services.json is present.
        classpath("com.google.gms:google-services:4.4.4")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}

