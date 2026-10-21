// 桩：@deepseek-ai/dsh-home-paths
export function resolveDshHome() {
  return process.env.HOSTSIM_DSH_HOME ?? process.cwd()
}
