/**
 * Copyright © 2014-2019 Tick42 OOD
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {default as CallbackRegistryFactory, CallbackRegistry} from "callback-registry";

import {AppIntent, Context, DesktopAgent, IntentResolution, Listener} from "./interfaces/interface";
import {Application, InteropPeerDescriptor, Method, MethodImplementation, Platform} from "./interfaces/client-api";
import Utils from "./utils";

const registry: CallbackRegistry = CallbackRegistryFactory();

class Fdc3Impl implements DesktopAgent {
  private platforms: Platform[];
  private defaultErrorMessage: string;

  constructor(platforms: Platform[] = []) {
    this.platforms = platforms;
  }

  public async open(app: string, context?: Context): Promise<any> {
    Utils.validateOpenParams(app, context);

    let platform: Platform;
    const platformName: string = this.getPlatformName(app);
    const appName: string = platformName ? this.getApplicationName(app) : app;
    this.defaultErrorMessage = `Unable to start application named "${appName}"`;

    try {
      platform = platformName ? await this.getPlatform(appName, platformName) : await this.getPlatform(app);
    } catch (error) {
      throw new Error(error.message || this.defaultErrorMessage);
    }

    const args: {application: string, context: Context} = {application: appName, context};
    const methodName: string = `Fdc3.${platform.name}.StartApplication`;
    try {
      const startInvokeResult: any = await platform.platformApi.invoke(methodName, args);
      return startInvokeResult.result;
    } catch (error) {
      throw new Error(this.defaultErrorMessage);
    }
  }

  public async findIntent(intent: string, context?: Context): Promise<AppIntent> {
    Utils.validateIntentAndContextParams(intent, context);
    const appIntent: AppIntent = {
      intent: {name: intent, displayName: intent},
      apps: []
    };

    for (const platform of this.platforms) {
      const methods: Method[] = await platform.platformApi.discoverMethods();
      for (const method of methods) {
        if (method.intent && method.intent.length > 0) {
          for (const methodIntent of method.intent) {
            if (methodIntent.name === intent &&
               (!context || JSON.stringify(context) === JSON.stringify(methodIntent.context))) {
              appIntent.apps.push({name: method.peer.applicationName});
            }
          }
        }
      }
    }

    return appIntent;
  }

  public async findIntentsByContext(context: Context): Promise<AppIntent[]> {
    Utils.validateContext(context);
    const appIntents: AppIntent[] = [];

    for (const platform of this.platforms) {
      const methods: Method[] = await platform.platformApi.discoverMethods();
      for (const method of methods) {
        if (method.intent && method.intent.length > 0) {
          for (const methodIntent of method.intent) {
            if (JSON.stringify(methodIntent.context) === JSON.stringify(context)) {
              const intent: AppIntent = appIntents.find((appIntent: AppIntent) =>
                appIntent.intent.name === methodIntent.name);
              if (intent) {
                intent.apps.push({name: method.peer.applicationName});
              } else {
                appIntents.push({
                  intent: {name: methodIntent.name, displayName: methodIntent.name},
                  apps: [{name: method.peer.applicationName}]
                });
              }
            }
          }
        }
      }
    }

    return appIntents;
  }

  public broadcast(context: Context): void {
    if (!context) {
      throw new Error("Context is mandatory parameter");
    }
    Utils.validateContext(context);

    this.platforms.forEach(async (platform: Platform) => {
      try {
        const methods: Method[] = await platform.platformApi.discoverMethods();
        const contextListenerMethods: Method[] = methods
          .filter((method: Method) => method.name === `Fdc3.${platform.name}.ContextListener`);
        for (const method of contextListenerMethods) {
          await platform.platformApi.invoke(method, context);
        }
      } catch (error) {
        return;
      }
    });
  }

  public async raiseIntent(intent: string, context: Context, target?: string): Promise<IntentResolution> {
    Utils.validateRaiseIntent(intent, context, target);

    for (const platform of this.platforms) {
      const methods: Method[] = await platform.platformApi.discoverMethods();
      const methodsWithIntent: Method[] = methods.filter((method: Method) => {
        if (method.intent && method.intent.length > 0) {
          for (const methodIntent of method.intent) {
            if (methodIntent.name === intent) {
              if (target) {
                if (method.peer && method.peer.applicationName === target) {
                  return method;
                }
              } else {
                return method;
              }
            }
          }
        }
      });

      if (methodsWithIntent.length === 0) {
        throw new Error(`There is no method with intent "${intent}"`);
      }
      if (methodsWithIntent.length > 1) {
        throw new Error(`There are multiple applications with method with intent "${intent}"`);
      }

      const invokeResult = await platform.platformApi.invoke(methodsWithIntent[0], context);
      return invokeResult.result;
    }
  }

  public addIntentListener(intent: string, handler: (context: Context) => void): Listener {
    Utils.validateAddIntentListener(intent, handler);

    const unsubscribeFunction = registry.add("add-intent", handler);
    const unsubscribe: () => void = () => {
      unsubscribeFunction();
    };

    for (const platform of this.platforms) {
      platform.platformApi.onMethodRegistered((method: Method) => {
        if (method.intent && method.intent.length > 0) {
          for (const methodIntent of method.intent) {
            if (methodIntent.name === intent) {
              registry.execute("add-intent", methodIntent.context);
            }
          }
        }
      });
    }
    return {unsubscribe};
  }

  public addContextListener(handler: (context: Context) => void): Listener {
    if (!handler) {
      throw new Error("Handler is mandatory parameter");
    }
    if (typeof handler !== "function") {
      throw new Error(`Handler must be of type "function"`);
    }

    const unsubscribeFunction = registry.add("add-context", handler);
    const unsubscribe: () => void = () => {
      unsubscribeFunction();
    };

    for (const platform of this.platforms) {
      const method: MethodImplementation = {
        name: `Fdc3.${platform.name}.ContextListener`,
        onInvoke: (context: Context, peer: InteropPeerDescriptor) => {
          return Promise.resolve(registry.execute("add-context", context));
        }
      };
      platform.platformApi.register(method);
    }

    return {unsubscribe};
  }

  private getPlatformName(app: string): string {
    const splitAppName: string[] = app.split(":");
    return splitAppName.length > 1 ? splitAppName[splitAppName.length - 1] : null;
  }

  private getApplicationName(app: string): string {
    const splitAppName = app.split(":");
    if (splitAppName.length > 1) {
      splitAppName.pop();
      return splitAppName.join(":");
    } else {
      return app;
    }
  }

  private async getPlatform(appName: string, platformName?: string): Promise<Platform> {
    if (platformName) {
      try {
        const platform: Platform = this.getUniquePlatform(platformName);
        return platform;
      } catch (error) {
        throw new Error(error.message || this.defaultErrorMessage);
      }
    } else {
      const platformsSupportingListApplicationsMethod: Platform[] = [];
      for (const platform of this.platforms) {
        const platformMethods = await platform.platformApi.discoverMethods();
        if (this.platformHasMethod(platform, platformMethods, "ListApplications")) {
          platformsSupportingListApplicationsMethod.push(platform);
        }
      }

      const platformsWithProvidedApp: Platform[] = [];
      for (const platform of platformsSupportingListApplicationsMethod) {
        const platformHasProvidedApp: boolean = await this.platformHasProvidedApp(platform, appName);
        if (platformHasProvidedApp) {
          platformsWithProvidedApp.push(platform);
        }
      }

      if (platformsWithProvidedApp.length === 0) {
        throw new Error(`There are no platforms with application named '${appName}'.`);
      }
      if (platformsWithProvidedApp.length > 1) {
        throw new Error(`There are multiple platforms with application named '${appName}'.`);
      }

      const platformsSupportingStartApplicationMethod: Platform[] = [];
      for (const platform of platformsWithProvidedApp) {
        const platformMethods = await platform.platformApi.discoverMethods();
        if (this.platformHasMethod(platform, platformMethods, "StartApplication")) {
          platformsSupportingStartApplicationMethod.push(platform);
        }
      }

      return platformsSupportingStartApplicationMethod[0];
    }
  }

  private getUniquePlatform(platformName: string): Platform {
    const fdc3Platforms: Platform[] = this.platforms
      .filter((fdc3Platform: Platform) => fdc3Platform.name === platformName);
    if (fdc3Platforms.length === 0) {
      throw new Error(`There is no platform named "${platformName}"`);
    }
    if (fdc3Platforms.length > 1) {
      throw new Error(`There are multiple platforms named "${platformName}"`);
    }
    return fdc3Platforms[0];
  }

  private platformHasMethod(platform: Platform, platformMethods: any[], methodName: string): boolean {
    const methodFullName: string = `Fdc3.${platform.name}.${methodName}`;
    return platformMethods.filter((method: any) => method.name === methodFullName).length > 0;
  }

  private async platformHasProvidedApp(platform: Platform, app: string): Promise<boolean> {
    const listApplicationsMethodName: string = `Fdc3.${platform.name}.ListApplications`;
    let platformApplications: Application[];
    try {
      const listApplicationsInvocation = await platform.platformApi.invoke(listApplicationsMethodName);
      platformApplications = listApplicationsInvocation.result;
    } catch (error) {
      return false;
    }
    const providedAppList: Application[] = platformApplications
      .filter((application: Application) => application.name === app);
    if (providedAppList.length > 1) {
      throw new Error(`There are multiple applications named '${app}'.`);
    }
    return providedAppList.length === 1;
  }
}

export default async function Fdc3Bus(interopPlatforms: any[], methods: MethodImplementation[]): Promise<Fdc3Impl> {
  const interopPlatformNames: string[] = interopPlatforms.map((interopPlatform) => interopPlatform.type);
  const interopPlatformNamesSet: Set<string> = new Set(interopPlatformNames);
  if (interopPlatformNames.length !== interopPlatformNamesSet.size) {
    throw new Error("Multiple platforms have the same type.");
  }

  const platforms: any = await Utils.interopPlatformsToPlatforms(interopPlatforms, methods);
  const fdc3ImplObj: any = new Fdc3Impl(platforms);
  return fdc3ImplObj;
}
