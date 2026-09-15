import java.io.File
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
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        val abiDir = when (target) {
            "aarch64" -> "arm64-v8a"
            "armv7" -> "armeabi-v7a"
            "i686" -> "x86"
            "x86_64" -> "x86_64"
            else -> target
        }
        val jniLibs = File(project.projectDir, "src/main/jniLibs")
        val soFile = File(jniLibs, "$abiDir/libnihonforge_lib.so")
        if (soFile.exists()) {
            project.logger.lifecycle("libnihonforge_lib.so already exists at ${soFile.absolutePath}, skipping Rust build")
            return
        }
        // npm dicari lewat PATH agar portabel (Windows: npm.cmd, lainnya: npm).
        // Nilai lama hardcoded ke path Windows mesin asal init dan merusak build CI.
        val executable = if (System.getProperty("os.name").startsWith("Windows", ignoreCase = true)) "npm.cmd" else "npm";
        runTauriCli(executable)
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