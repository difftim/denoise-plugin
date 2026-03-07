plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    id("maven-publish")
}

tasks.register<Exec>("buildRnnoise") {
    val libsDir = file("${project.rootDir}/libs")
    onlyIf { !libsDir.exists() || libsDir.listFiles()?.isEmpty() != false }
    workingDir = project.rootDir
    commandLine("bash", "build_rnnoise.sh")
}

tasks.configureEach {
    if (name.startsWith("merge") && name.endsWith("JniLibFolders")) {
        dependsOn("buildRnnoise")
    }
}

android {
    namespace = "org.difft.android.libraries.denoise_filter"
    compileSdk = 35

    defaultConfig {
        minSdk = 21
        targetSdk = 35

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
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

    sourceSets {
        getByName("main") {
            jniLibs.srcDirs("${project.rootDir}/libs")
        }
    }

    packagingOptions {
        jniLibs {
            useLegacyPackaging = true // 确保不对 .so 文件进行 strip
        }
    }
}

dependencies {
//    implementation(libs.androidx.core.ktx)
//    implementation(libs.androidx.appcompat)
//    implementation(libs.material)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)

    implementation(libs.livekit.android)
    implementation(fileTree(mapOf("dir" to "libs", "include" to listOf("*.jar", "*.aar"))))
}

apply(from = rootProject.file("gradle/gradle-mvn-push.gradle"))

afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components["release"])

                groupId = project.findProperty("GROUP") as String
                artifactId = project.findProperty("POM_ARTIFACT_ID") as String
                version = project.findProperty("VERSION_NAME") as String
            }
        }
    }
}