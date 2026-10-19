/** Every check of the environment of the visit. A setting that names a check is validated against this list. */
export const environmentCheckIds = ['private_mode_likely', 'virtual_machine_gpu', 'software_renderer'] as const

export type EnvironmentCheckId = typeof environmentCheckIds[number]
