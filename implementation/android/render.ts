import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from 'node:module';

const { DOMParser } = createRequire(import.meta.url)('./vendor/xmldom');

// Build-time rendering of the Android Gradle project files from typed settings.

export interface AndroidShellSettings {
  packageId: string;
  applicationName: string;
  minSdk: number;
}

export interface AndroidRenderOptions {
  // Folders (relative to the Android project) whose Kotlin and resource sources join the application, each containing src/main/java and optionally src/main/res.
  componentFolders?: string[];
  // Gradle dependency coordinates added to the application, for example "com.squareup.okhttp3:okhttp:4.12.0".
  dependencies?: string[];
  // Gradle dependency coordinates for the unit tests (src/test), for example "junit:junit:4.13.2".
  testDependencies?: string[];
  // Android permission names such as "android.permission.INTERNET".
  permissions?: string[];
  // Declares the camera as optional hardware (for applications that ask for CAMERA).
  cameraOptional?: boolean;
  // Activity class: ".MainActivity" is relative to packageId.
  activityName?: string;
  orientation?: "portrait" | "landscape" | "unspecified";
  compileSdk?: number;
  projectName?: string;
  // Prefix of the environment variables that carry the signing keystore, by reference (default: packageId's last word in capitals).
  signingPrefix?: string;
  allowCleartext?: boolean;
  // Applies the Kotlin serialization compiler plugin (for @Serializable classes).
  kotlinSerialization?: boolean;
  // Extra Maven repositories (https addresses) for dependencies, for example "https://jitpack.io".
  repositories?: string[];
  // String BuildConfig fields, each overridable at build time with a Gradle property (`./gradlew -P<property>=<value>`).
  buildConfigStrings?: { name: string; property: string; value: string }[];
}

export class SettingsError extends Error {}

const QUALIFIED = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
const LABEL = /^[A-Za-z][A-Za-z0-9 -]{0,63}$/;
const MIN_SDK = 21;
const MAX_SDK = 36;

export interface ResolvedAndroidSettings extends AndroidShellSettings {
  compileSdk: number;
}

export function validateSettings(settings: AndroidShellSettings, options: AndroidRenderOptions = {}): ResolvedAndroidSettings {
  if (typeof settings.packageId !== "string" || !QUALIFIED.test(settings.packageId)) throw new SettingsError("packageId must be lower-case words separated by dots");
  if (typeof settings.applicationName !== "string" || !LABEL.test(settings.applicationName)) throw new SettingsError("applicationName must be a label");
  const compileSdk = options.compileSdk ?? MAX_SDK;
  if (!Number.isInteger(compileSdk) || compileSdk < MIN_SDK || compileSdk > 99) throw new SettingsError("compileSdk must be a whole number");
  if (!Number.isInteger(settings.minSdk) || settings.minSdk < MIN_SDK || settings.minSdk > compileSdk) throw new SettingsError(`minSdk must be a whole number from ${MIN_SDK} to compileSdk`);
  return { ...settings, compileSdk };
}

const TOKEN = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

// {{name}} inserts the named value as written; the caller validates values first. Unknown or malformed tokens are errors.
export function fill(template: string, values: Record<string, string | number>): string {
  if (template.replace(TOKEN, "").includes("{{")) throw new SettingsError("template has a malformed token");
  return template.replace(TOKEN, (_match, name: string) => {
    if (!Object.hasOwn(values, name)) throw new SettingsError(`template names unknown value ${name}`);
    return String(values[name]);
  });
}

const template = (name: string) => readFileSync(new URL(`./templates/${name}.template`, import.meta.url), "utf8");

function checkOptions(options: AndroidRenderOptions): void {
  for (const folder of options.componentFolders ?? []) if (!/^(\.\.\/)*[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(folder) || folder.includes("/../")) throw new SettingsError(`component folder ${folder} must be a plain relative path`);
  for (const dependency of [...(options.dependencies ?? []), ...(options.testDependencies ?? [])]) if (!/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.+-]+$/.test(dependency)) throw new SettingsError(`dependency ${dependency} must be group:name:version`);
  for (const permission of options.permissions ?? []) if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(permission)) throw new SettingsError(`permission ${permission} is not a permission name`);
  if (options.activityName !== undefined && !/^\.?[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/.test(options.activityName)) throw new SettingsError("activityName must be a class name");
  if (options.signingPrefix !== undefined && !/^[A-Z][A-Z0-9_]{0,63}$/.test(options.signingPrefix)) throw new SettingsError("signingPrefix must be capitals, digits and underscores");
  if (options.projectName !== undefined && !LABEL.test(options.projectName)) throw new SettingsError("projectName must be a label");
  for (const f of options.buildConfigStrings ?? []) if (!/^[A-Z][A-Z0-9_]*$/.test(f.name) || !/^[a-z][A-Za-z0-9]*$/.test(f.property) || !/^[A-Za-z0-9:\/._-]*$/.test(f.value)) throw new SettingsError(`build config field ${f.name} needs a capitalised name, a camelCase property and a plain value`);
  for (const url of options.repositories ?? []) if (!/^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._\/-]*)?$/.test(url)) throw new SettingsError(`repository ${url} must be an https address`);
  if (options.orientation !== undefined && !["portrait", "landscape", "unspecified"].includes(options.orientation)) throw new SettingsError("orientation must be portrait, landscape or unspecified");
}

export function renderAppBuild(settings: ResolvedAndroidSettings, options: AndroidRenderOptions = {}): string {
  checkOptions(options);
  const folders = options.componentFolders ?? [];
  const sourceSets = folders.length
    ? "\n" + ["    listOf(" + folders.map((folder) => JSON.stringify(folder)).join(", ") + ").forEach { folder ->",
      '        sourceSets.getByName("main").java.srcDir("../$folder/src/main/java")',
      '        sourceSets.getByName("main").res.srcDir("../$folder/src/main/res")',
      "    }"].join("\n") + "\n"
    : "";
  const dependencies = (options.dependencies ?? []).map((dependency) => `    implementation(${JSON.stringify(dependency)})\n`).join("")
    + (options.testDependencies ?? []).map((dependency) => `    testImplementation(${JSON.stringify(dependency)})\n`).join("");
  return fill(template("app.build.gradle.kts"), {
    packageId: settings.packageId, applicationName: settings.applicationName, minSdk: settings.minSdk, compileSdk: settings.compileSdk,
    signingPrefix: options.signingPrefix ?? signingPrefix(settings.packageId), componentSourceSets: sourceSets, dependencies,
    buildConfigFields: (options.buildConfigStrings ?? []).map((f) => `        buildConfigField("String", "${f.name}", "\\"\${(findProperty("${f.property}") as String?) ?: "${f.value}"}\\"")\n`).join(""),
    plugins: options.kotlinSerialization ? '    id("org.jetbrains.kotlin.plugin.serialization")\n' : "",
  });
}

export function signingPrefix(packageId: string): string {
  return packageId.split(".").pop()!.toUpperCase();
}

export function renderManifest(settings: ResolvedAndroidSettings, options: AndroidRenderOptions = {}): string {
  checkOptions(options);
  const permissions = (options.permissions ?? []).map((name) => `    <uses-permission android:name="${name}" />\n`).join("")
    + (options.cameraOptional ? '    <uses-feature android:name="android.hardware.camera" android:required="false" />\n' : "");
  let manifest = fill(template("AndroidManifest.xml"), {
    permissions, activityName: options.activityName ?? ".MainActivity", orientation: options.orientation ?? "portrait",
  });
  if (options.allowCleartext) manifest = manifest.replace('android:allowBackup="false"', 'android:allowBackup="false"\n        android:usesCleartextTraffic="true"');
  return manifest.replace("\n\n\n", "\n\n");
}

// Output path (relative to the Android project folder) to file text.
export function renderAndroid(settings: AndroidShellSettings, options: AndroidRenderOptions = {}): Record<string, string> {
  const resolved = validateSettings(settings, options);
  checkOptions(options);
  return {
    "settings.gradle.kts": fill(template("settings.gradle.kts"), {
      projectName: options.projectName ?? settings.applicationName,
      repositories: (options.repositories ?? []).map((url) => `        maven(${JSON.stringify(url)})\n`).join(""),
    }),
    "build.gradle.kts": template("build.gradle.kts"),
    "gradle.properties": template("gradle.properties"),
    "gradle/wrapper/gradle-wrapper.properties": template("gradle/wrapper/gradle-wrapper.properties"),
    "app/build.gradle.kts": renderAppBuild(resolved, options),
    "app/src/main/AndroidManifest.xml": renderManifest(resolved, options),
    "app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml": template("ic_launcher.xml"),
    "app/src/main/res/drawable/ic_launcher_background.xml": template("app/src/main/res/drawable/ic_launcher_background.xml"),
    "app/src/main/res/drawable/ic_launcher_foreground.xml": template("app/src/main/res/drawable/ic_launcher_foreground.xml"),
  };
}

export function writeAndroid(directory: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

export type DependencyFiles = {
  'buildscript-gradle.lockfile': string;
  'app/buildscript-gradle.lockfile': string;
  'app/gradle.lockfile': string;
  'gradle/verification-metadata.xml': string;
};
const DEPENDENCY_PATHS: (keyof DependencyFiles)[] = ['buildscript-gradle.lockfile', 'app/buildscript-gradle.lockfile', 'app/gradle.lockfile', 'gradle/verification-metadata.xml'];
function lockedDependencies(): DependencyFiles {
  return Object.fromEntries(DEPENDENCY_PATHS.map(path => [path, readFileSync(new URL(`./dependencies/${path}`, import.meta.url), 'utf8')])) as DependencyFiles;
}

function validateDependencyFiles(files: Record<string, string>): void {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new SettingsError('dependencyFiles must be a complete file map');
  for (const path of Object.keys(files)) if (!DEPENDENCY_PATHS.includes(path) || typeof files[path] !== 'string' || !files[path].trim() || /[\uD800-\uDFFF]/u.test(files[path])) throw new SettingsError(`invalid dependency file ${path}`);
  for (const path of DEPENDENCY_PATHS) if (!(path in files)) throw new SettingsError(`missing dependency file ${path}`);
  const coordinates = new Set<string>();
  for (const path of DEPENDENCY_PATHS.filter(path => path.endsWith('.lockfile'))) {
    const configurations = new Map<string, string>();
    let emptySeen = false;
    for (const line of files[path].split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const fields = line.split('=');
      if (fields.length !== 2) throw new SettingsError(`invalid lock line in ${path}`);
      const [coordinate, raw] = fields;
      const names = raw ? raw.split(',') : [];
      if (names.some(name => !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) || new Set(names).size !== names.length) throw new SettingsError(`invalid lock configurations in ${path}`);
      if (coordinate === 'empty') {
        if (emptySeen) throw new SettingsError(`duplicate empty lock entry in ${path}`);
        emptySeen = true;
        continue;
      }
      if (!/^[^\s:=,]+:[^\s:=,]+:[^\s:=,+]+$/.test(coordinate) || !names.length) throw new SettingsError(`invalid locked coordinate in ${path}`);
      const parts = coordinate.split(':');
      for (const name of names) {
        const key = parts.slice(0, 2).join(':') + ':' + name;
        if (configurations.has(key)) throw new SettingsError(`duplicate locked configuration ${key}`);
        configurations.set(key, parts[2]);
      }
      coordinates.add(coordinate);
    }
  }
  const xml = files['gradle/verification-metadata.xml'];
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new SettingsError('invalid dependency verification document');
  const reject = (message: string) => { throw new SettingsError(`invalid dependency verification document: ${message}`); };
  const document = new DOMParser({ errorHandler: { warning: reject, error: reject, fatalError: reject } }).parseFromString(xml, 'application/xml');
  const namespace = 'https://schema.gradle.org/dependency-verification';
  const root = document.documentElement;
  if (root?.localName !== 'verification-metadata' || root.namespaceURI !== namespace) reject('unexpected root');
  const containers: any[] = Array.from(root.getElementsByTagNameNS(namespace, 'components'));
  if (containers.length !== 1 || containers[0].parentNode !== root) reject('expected one components inventory');
  const verified = new Set<string>();
  const components: any[] = Array.from(containers[0].getElementsByTagNameNS(namespace, 'component'));
  for (const component of components) {
    if (component.parentNode !== containers[0]) reject('nested verification component');
    const values = ['group', 'name', 'version'].map(name => component.getAttribute(name));
    const coordinate = values.join(':');
    if (values.some(value => !value) || verified.has(coordinate)) throw new SettingsError('invalid verification component');
    const artifacts: any[] = Array.from(component.getElementsByTagNameNS(namespace, 'artifact'));
    if (!artifacts.length || new Set(artifacts.map(artifact => artifact.getAttribute('name'))).size !== artifacts.length) throw new SettingsError(`invalid verification artifacts for ${coordinate}`);
    for (const artifact of artifacts) {
      if (artifact.parentNode !== component) reject('nested verification artifact');
      const name = artifact.getAttribute('name');
      if (!name || /[\\/]/.test(name) || name === '.' || name === '..') reject('invalid artifact name');
      const hashes: any[] = Array.from(artifact.getElementsByTagNameNS(namespace, 'sha256'));
      const additional: any[] = Array.from(artifact.getElementsByTagNameNS(namespace, 'also-trust'));
      if (!hashes.length || hashes.some(hash => hash.parentNode !== artifact) || additional.some(hash => !hashes.includes(hash.parentNode)) || [...hashes, ...additional].some(hash => !/^[a-f0-9]{64}$/.test(hash.getAttribute('value')))) throw new SettingsError(`invalid checksum for ${name}`);
    }
    verified.add(coordinate);
  }
  for (const coordinate of coordinates) if (!verified.has(coordinate)) throw new SettingsError(`missing checksums for ${coordinate}`);
}

// Copy the Gradle wrapper and the exact dependency locks and checksums into the project.
export function writeWrapper(directory: string, dependencyFiles: DependencyFiles = lockedDependencies()): void {
  validateDependencyFiles(dependencyFiles);
  for (const path of ["gradlew", "gradlew.bat", "gradle/wrapper/gradle-wrapper.jar"]) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(new URL(`./wrapper/${path}`, import.meta.url), target);
  }
  chmodSync(join(directory, "gradlew"), 0o755);
  writeAndroid(directory, dependencyFiles);
}
