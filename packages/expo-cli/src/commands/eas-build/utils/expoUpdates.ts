import { getConfig, getExpoSDKVersion, getPackageJson } from '@expo/config';
import plist from '@expo/plist';
import { UserManager } from '@expo/xdl';
import chalk from 'chalk';
import figures from 'figures';
import * as fs from 'fs-extra';
import glob from 'glob';
import ora from 'ora';
import path from 'path';
import xcode from 'xcode';
import { DOMParser, XMLSerializer } from 'xmldom';

import { gitAddAsync } from '../../../git';
import log from '../../../log';
import * as gitUtils from './git';

type ConfigurationOptions =
  | {
      sdkVersion: string;
      runtimeVersion?: undefined;
      updateUrl: string;
    }
  | {
      sdkVersion?: undefined;
      runtimeVersion: string;
      updateUrl: string;
    };

enum ExpoAndroidMetadata {
  SDK_VERSION = 'expo.modules.updates.EXPO_SDK_VERSION',
  RUNTIME_VERSION = 'expo.modules.updates.EXPO_RUNTIME_VERSION',
  UPDATE_URL = 'expo.modules.updates.EXPO_UPDATE_URL',
}

enum ExpoIOSMetadata {
  SDK_VERSION = 'EXUpdatesRuntimeVersion',
  RUNTIME_VERSION = 'EXUpdatesSDKVersion',
  UPDATE_URL = 'EXUpdatesURL',
}

const iOSBuildScript = '../node_modules/expo-updates/scripts/create-manifest-ios.sh';
const androidBuildScript =
  'apply from: "../../node_modules/expo-updates/scripts/create-manifest-android.gradle"';

export async function isUpdatesConfigured(projectDir: string): Promise<boolean> {
  if (!isExpoUpdatesInstalled(projectDir)) {
    return true;
  }

  const options = await getConfigurationOptions(projectDir);

  return (
    (await isUpdatesConfiguredAndroid(projectDir, options)) &&
    (await isUpdatesConfiguredIOS(projectDir, options))
  );
}

export async function configureUpdatesAsync({
  projectDir,
  nonInteractive,
}: {
  projectDir: string;
  nonInteractive: boolean;
}) {
  if (!isExpoUpdatesInstalled(projectDir)) {
    return;
  }

  const spinner = ora('Configuring expo-updates');

  const options = await getConfigurationOptions(projectDir);

  await configureUpdatesAndroid(projectDir, options);
  await configureUpdatesIOS(projectDir, options);

  try {
    await gitUtils.ensureGitStatusIsCleanAsync();
    spinner.succeed();
  } catch (err) {
    if (err instanceof gitUtils.DirtyGitTreeError) {
      spinner.succeed(`We configured expo-updates in your project `);
      log.newLine();

      try {
        await gitUtils.reviewAndCommitChangesAsync(`Configure expo-updates`, { nonInteractive });

        log(`${chalk.green(figures.tick)} Successfully committed the configuration changes.`);
      } catch (e) {
        throw new Error(
          "Aborting, run the command again once you're ready. Make sure to commit any changes you've made."
        );
      }
    } else {
      spinner.fail();
      throw err;
    }
  }
}

async function getConfigurationOptions(projectDir: string): Promise<ConfigurationOptions> {
  const user = await UserManager.ensureLoggedInAsync();

  const { exp } = getConfig(projectDir);
  const updateUrl = `https://exp.host/@${user.username}/${exp.slug}`;

  if (exp.runtimeVersion) {
    return {
      runtimeVersion: exp.runtimeVersion,
      updateUrl,
    };
  }

  try {
    const sdkVersion = getExpoSDKVersion(projectDir, exp);

    return {
      sdkVersion,
      updateUrl,
    };
  } catch (err) {
    throw new Error(
      "Couldn't find either 'runtimeVersion' or 'sdkVersion' to configure 'expo-updates'. Please specify at least one of these properties under the 'expo' key in 'app.json'"
    );
  }
}

function isExpoUpdatesInstalled(projectDir: string) {
  const packageJson = getPackageJson(projectDir);

  return packageJson.dependencies && 'expo-updates' in packageJson.dependencies;
}

async function configureUpdatesIOS(
  projectDir: string,
  { sdkVersion, runtimeVersion, updateUrl }: ConfigurationOptions
) {
  const pbxprojPath = await getPbxprojPath(projectDir);
  const project = await getXcodeProject(pbxprojPath);
  const bundleReactNative = await getBundleReactNativePhase(project);

  if (!bundleReactNative.shellScript.includes(iOSBuildScript)) {
    bundleReactNative.shellScript = `${bundleReactNative.shellScript.replace(
      /"$/,
      ''
    )}${iOSBuildScript}\\n"`;
  }

  await fs.writeFile(pbxprojPath, project.writeSync());

  const items = runtimeVersion
    ? {
        [ExpoIOSMetadata.RUNTIME_VERSION]: runtimeVersion,
        [ExpoIOSMetadata.UPDATE_URL]: updateUrl,
      }
    : {
        [ExpoIOSMetadata.SDK_VERSION]: sdkVersion,
        [ExpoIOSMetadata.UPDATE_URL]: updateUrl,
      };

  const expoPlistPath = getExpoPlistPath(projectDir, pbxprojPath);
  const expoPlist = plist.build(items);

  if (!(await fs.pathExists(path.dirname(expoPlistPath)))) {
    await fs.mkdirp(path.dirname(expoPlistPath));
  }

  await fs.writeFile(expoPlistPath, expoPlist);
  await gitAddAsync(expoPlistPath, { intentToAdd: true });
}

async function isUpdatesConfiguredIOS(
  projectDir: string,
  { sdkVersion, runtimeVersion, updateUrl }: ConfigurationOptions
) {
  const pbxprojPath = await getPbxprojPath(projectDir);
  const project = await getXcodeProject(pbxprojPath);
  const bundleReactNative = await getBundleReactNativePhase(project);

  if (!bundleReactNative.shellScript.includes(iOSBuildScript)) {
    return false;
  }

  const expoPlistPath = getExpoPlistPath(projectDir, pbxprojPath);

  if (!(await fs.pathExists(expoPlistPath))) {
    return false;
  }

  const expoPlist = await fs.readFile(expoPlistPath, 'utf8');
  const expoPlistData = plist.parse(expoPlist);

  if (
    (runtimeVersion
      ? expoPlistData[ExpoIOSMetadata.RUNTIME_VERSION] === runtimeVersion
      : expoPlistData[ExpoIOSMetadata.SDK_VERSION] === sdkVersion) &&
    expoPlistData[ExpoIOSMetadata.UPDATE_URL] === updateUrl
  ) {
    return true;
  }

  return false;
}

async function getPbxprojPath(projectDir: string) {
  const pbxprojPaths = await new Promise<string[]>((resolve, reject) =>
    glob('ios/*/project.pbxproj', { absolute: true, cwd: projectDir }, (err, res) => {
      if (err) {
        reject(err);
      } else {
        resolve(res);
      }
    })
  );

  const pbxprojPath = pbxprojPaths.length > 0 ? pbxprojPaths[0] : undefined;

  if (!pbxprojPath) {
    throw new Error("Couldn't find Xcode project");
  }

  return pbxprojPath;
}

async function getXcodeProject(pbxprojPath: string) {
  const project = xcode.project(pbxprojPath);

  await new Promise((resolve, reject) =>
    project.parse(err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    })
  );

  return project;
}

function getExpoPlistPath(projectDir: string, pbxprojPath: string) {
  const xcodeprojPath = path.resolve(pbxprojPath, '..');
  const expoPlistPath = path.resolve(
    projectDir,
    'ios',
    path.basename(xcodeprojPath).replace(/\.xcodeproj$/, ''),
    'Supporting',
    'Expo.plist'
  );

  return expoPlistPath;
}

async function getBundleReactNativePhase(project: xcode.XcodeProject) {
  const scriptBuildPhase = project.hash.project.objects.PBXShellScriptBuildPhase;
  const bundleReactNative = Object.values(scriptBuildPhase).find(
    buildPhase => buildPhase.name === '"Bundle React Native code and images"'
  );

  if (!bundleReactNative) {
    throw new Error(`Couldn't find a build phase script for "Bundle React Native code and images"`);
  }

  return bundleReactNative;
}

async function configureUpdatesAndroid(projectDir: string, options: ConfigurationOptions) {
  const buildGradlePath = getAndroidBuildGradlePath(projectDir);
  const buildGradleContent = await getAndroidBuildGradleContent(buildGradlePath);

  if (!hasBuildScriptApply(buildGradleContent)) {
    await fs.writeFile(
      buildGradlePath,
      `${buildGradleContent}\n// Integration with Expo updates\n${androidBuildScript}\n`
    );
  }

  const manifestPath = getAndroidManifestPath(projectDir);
  const manifestXml = await getAndroidManifest(manifestPath);

  if (!isAndroidMetadataSet(manifestXml, options)) {
    if (options.runtimeVersion) {
      removeAndroidMetadata(manifestXml, ExpoAndroidMetadata.SDK_VERSION);
      updateAndroidMetadata(
        manifestXml,
        ExpoAndroidMetadata.RUNTIME_VERSION,
        options.runtimeVersion
      );
    } else if (options.sdkVersion) {
      removeAndroidMetadata(manifestXml, ExpoAndroidMetadata.RUNTIME_VERSION);
      updateAndroidMetadata(manifestXml, ExpoAndroidMetadata.SDK_VERSION, options.sdkVersion);
    }

    updateAndroidMetadata(manifestXml, ExpoAndroidMetadata.UPDATE_URL, options.updateUrl);

    await fs.writeFile(manifestPath, new XMLSerializer().serializeToString(manifestXml));
  }
}

async function isUpdatesConfiguredAndroid(projectDir: string, options: ConfigurationOptions) {
  const buildGradlePath = getAndroidBuildGradlePath(projectDir);
  const buildGradleContent = await getAndroidBuildGradleContent(buildGradlePath);

  if (!hasBuildScriptApply(buildGradleContent)) {
    return false;
  }

  const manifestPath = getAndroidManifestPath(projectDir);
  const manifestXml = await getAndroidManifest(manifestPath);

  if (!isAndroidMetadataSet(manifestXml, options)) {
    return false;
  }

  return true;
}

function getAndroidBuildGradlePath(projectDir: string) {
  const buildGradlePath = path.join(projectDir, 'android', 'app', 'build.gradle');

  return buildGradlePath;
}

async function getAndroidBuildGradleContent(buildGradlePath: string) {
  if (!(await fs.pathExists(buildGradlePath))) {
    throw new Error(`Couldn't find gradle build script at ${buildGradlePath}`);
  }

  const buildGradleContent = await fs.readFile(buildGradlePath, 'utf-8');

  return buildGradleContent;
}

function hasBuildScriptApply(buildGradleContent: string): boolean {
  return (
    buildGradleContent
      .split('\n')
      // Check for both single and double quotes
      .some(line => line === androidBuildScript || line === androidBuildScript.replace(/"/g, "'"))
  );
}

function getAndroidManifestPath(projectDir: string) {
  const manifestPath = path.join(
    projectDir,
    'android',
    'app',
    'src',
    'main',
    'AndroidManifest.xml'
  );

  return manifestPath;
}

async function getAndroidManifest(manifestPath: string) {
  if (!(await fs.pathExists(manifestPath))) {
    throw new Error(`Couldn't find Android manifest at ${manifestPath}`);
  }

  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const manifestXml = new DOMParser().parseFromString(manifestText);

  return manifestXml;
}

function isAndroidMetadataSet(
  document: Document,
  { sdkVersion, runtimeVersion, updateUrl }: ConfigurationOptions
): boolean {
  const application = document.getElementsByTagName('application')[0];
  const sdkVersionMetadata = findAndroidMetadata(application, ExpoAndroidMetadata.SDK_VERSION);
  const runtimeVersionMetadata = findAndroidMetadata(
    application,
    ExpoAndroidMetadata.RUNTIME_VERSION
  );
  const updateUrlMetadata = findAndroidMetadata(application, ExpoAndroidMetadata.UPDATE_URL);

  return Boolean(
    (runtimeVersion
      ? runtimeVersionMetadata &&
        runtimeVersionMetadata.getAttribute('android:value') === runtimeVersion
      : sdkVersionMetadata && sdkVersionMetadata.getAttribute('android:value') === sdkVersion) &&
      updateUrlMetadata &&
      updateUrlMetadata.getAttribute('android:value') === updateUrl
  );
}

function findAndroidMetadata(application: Element, name: ExpoAndroidMetadata) {
  const metadata = (Array.from(application.childNodes) as Element[]).find(
    node =>
      node.nodeName === 'meta-data' &&
      Array.from(node.attributes).some(attr => attr.name === 'android:name' && attr.value === name)
  );

  return metadata;
}

function updateAndroidMetadata(document: Document, name: ExpoAndroidMetadata, value: string) {
  const application = document.getElementsByTagName('application')[0];
  const metadata = findAndroidMetadata(application, name);

  if (metadata) {
    metadata.setAttribute('android:value', value);
  } else {
    const it = document.createElement('meta-data');

    it.setAttribute('android:name', name);
    it.setAttribute('android:value', value);

    application.appendChild(document.createTextNode('  '));
    application.appendChild(it);
    application.appendChild(document.createTextNode('\n    '));
  }
}

function removeAndroidMetadata(document: Document, name: ExpoAndroidMetadata) {
  const application = document.getElementsByTagName('application')[0];
  const metadata = findAndroidMetadata(application, name);

  if (metadata) {
    application.removeChild(metadata);
  }
}
