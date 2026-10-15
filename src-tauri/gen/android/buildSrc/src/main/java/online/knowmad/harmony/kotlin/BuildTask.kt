import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

open class BuildTask : DefaultTask() {
    @Input
    var rootDirRel: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        settleGeneratedKotlin()
        val executable = """npm""";
        try {
            runTauriCli(executable)
        } catch (e: Exception) {
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                // Try different Windows-specific extensions
                val fallbacks = listOf(
                    "$executable.exe",
                    "$executable.cmd",
                    "$executable.bat",
                )
                
                var lastException: Exception = e
                for (fallback in fallbacks) {
                    try {
                        runTauriCli(fallback)
                        return
                    } catch (fallbackException: Exception) {
                        lastException = fallbackException
                    }
                }
                throw lastException
            } else {
                throw e;
            }
        }
    }

    // Deviation from the generated task. The wry and tauri build scripts write the Kotlin glue
    // in src/main/java/<package>/generated and list each file as rerun-if-changed. Cargo dates
    // a build script run from its start, so a file written during the run reads as changed to
    // the next cargo run. `tauri android build` runs cargo before Gradle; without this, the
    // cargo run below reruns both scripts and recompiles wry, tauri, every plugin and the app.
    // Only those scripts write the files: a fixed old mtime removes the false change, and a
    // missing file still reruns them.
    private fun settleGeneratedKotlin() {
        File(project.projectDir, "src/main/java").walkTopDown()
            .filter { it.isDirectory && it.name == "generated" }
            .flatMap { it.listFiles()?.asSequence() ?: emptySequence() }
            .filter { it.isFile }
            .forEach { it.setLastModified(GENERATED_MTIME_MS) }
    }

    fun runTauriCli(executable: String) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        val args = listOf("run", "--", "tauri", "android", "android-studio-script");

        project.exec {
            workingDir(File(project.projectDir, rootDirRel))
            executable(executable)
            args(args)
            if (project.logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (project.logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (release) {
                args("--release")
            }
            args(listOf("--target", target))
        }.assertNormalExitValue()
    }
}

// 2000-01-01T00:00:00Z. Older than any build script run; ZIP timestamps start at 1980.
private const val GENERATED_MTIME_MS = 946_684_800_000L
