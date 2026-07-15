type MachineVersionSource = {
  cliVersion?: string
  metadata?: string | null
}

export function machineCliVersion(machine: MachineVersionSource) {
  if (machine.cliVersion) return machine.cliVersion
  if (!machine.metadata) return ""

  try {
    const metadata = JSON.parse(machine.metadata) as { cliVersion?: unknown }
    return typeof metadata.cliVersion === "string" ? metadata.cliVersion : ""
  } catch {
    return ""
  }
}
