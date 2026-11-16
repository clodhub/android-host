import { renderAndroid, writeAndroid, writeWrapper, type AndroidRenderOptions, type AndroidShellSettings, type DependencyFiles } from "../implementation/android/render.ts";

// Build time: write the Gradle project, manifest and launcher icon files, then build with Gradle.
// The application's Kotlin sources and resources live under app/src/main in the same project.
export function buildProject(directory: string, settings: AndroidShellSettings, options: AndroidRenderOptions = {}, dependencyFiles?: DependencyFiles): string[] {
  const files = renderAndroid(settings, options);
  writeWrapper(directory, dependencyFiles);
  writeAndroid(directory, files);
  return [...Object.keys(files), 'gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar', 'buildscript-gradle.lockfile', 'app/buildscript-gradle.lockfile', 'app/gradle.lockfile', 'gradle/verification-metadata.xml'].sort();
}
