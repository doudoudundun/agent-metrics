declare module "../scripts/stage-runtime-config.mjs" {
  export const BUILD_TARGETS: string[];
  export const DEPLOY_TARGETS: Array<{
    packageName: string;
    folderName: string;
  }>;
}
