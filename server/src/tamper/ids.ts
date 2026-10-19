/** Every check that can report tampering. A setting that names a check is validated against this list. */
export const tamperCheckIds = [
  'user_agent_inconsistent',
  'platform_inconsistent',
  'worker_page_mismatch',
  'iframe_page_mismatch',
  'webgl_worker_mismatch',
  'gpu_platform_inconsistent',
  'client_hints_brands_mismatch',
  'language_header_mismatch',
  'native_functions_modified',
  'navigator_overridden_on_instance',
  'automation_markers',
  'headless_user_agent',
  'notification_permission_inconsistent',
  'impossible_values',
  'clock_skew',
  'nonce_context_mismatch',
] as const

export type TamperCheckId = typeof tamperCheckIds[number]
