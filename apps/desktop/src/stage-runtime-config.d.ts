declare module "../scripts/stage-runtime-config.mjs" {
  export const MANAGED_NODE_VERSION: string;
  export const BUILD_TARGETS: string[];
  export const DEPLOY_TARGETS: Array<{
    packageName: string;
    folderName: string;
  }>;
}
